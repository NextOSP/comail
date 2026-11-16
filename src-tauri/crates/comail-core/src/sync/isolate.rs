//! Isolate messages whose IMAP response the protocol parser rejects.
//!
//! async-imap cannot skip an unparseable FETCH item: the rejected bytes stay
//! at the head of the connection's read buffer, so the whole multi-UID
//! command fails and the session is unusable. Splitting the UID set narrows
//! such a failure to the offending UID(s), so every other message in the
//! window still syncs and the caller's cursor can move past the bad ones.
//!
//! [`Isolation`] only plans the requests; the caller performs each fetch
//! (and replaces its session after an unparseable response), which keeps
//! this logic synchronous and free of session types.

use crate::error::{CoreError, Result};

/// Failed FETCH attempts allowed while isolating unparseable messages in one
/// window. Each failure costs the caller a reconnect. One bad UID in a
/// 500-UID window takes ~10 failures and scattered ones ~8 each, so about
/// six bad messages per window fit; a server whose every response fails to
/// parse aborts instead of reconnecting ~1000 times.
pub(crate) const MAX_FAILED_ATTEMPTS: usize = 64;

pub(crate) struct Isolated<T> {
    pub items: Vec<T>,
    /// UIDs whose response could not be parsed even when fetched alone.
    pub unparseable: Vec<(u32, CoreError)>,
}

/// Request planner: fetch each set from [`Isolation::next_set`] and report
/// the outcome with [`Isolation::record`]. A set whose response cannot be
/// parsed ([`CoreError::ImapParse`]) is halved until the failure is pinned
/// to single UIDs. Any other error, or more than `max_failed_attempts` parse
/// failures, aborts the whole fetch.
pub(crate) struct Isolation<'a, T> {
    pending: Vec<&'a [u32]>,
    failed_attempts: usize,
    max_failed_attempts: usize,
    isolated: Isolated<T>,
}

impl<'a, T> Isolation<'a, T> {
    pub fn new(uids: &'a [u32], max_failed_attempts: usize) -> Self {
        Self {
            pending: vec![uids],
            failed_attempts: 0,
            max_failed_attempts,
            isolated: Isolated {
                items: Vec::new(),
                unparseable: Vec::new(),
            },
        }
    }

    /// The next UID set to fetch, or `None` once every UID is accounted for.
    pub fn next_set(&mut self) -> Option<&'a [u32]> {
        while let Some(set) = self.pending.pop() {
            if !set.is_empty() {
                return Some(set);
            }
        }
        None
    }

    /// Record the outcome of fetching `set`. `Err` means abort the fetch.
    pub fn record(&mut self, set: &'a [u32], fetched: Result<Vec<T>>) -> Result<()> {
        match fetched {
            Ok(items) => self.isolated.items.extend(items),
            Err(error @ CoreError::ImapParse(_)) => {
                self.failed_attempts += 1;
                if self.failed_attempts > self.max_failed_attempts {
                    return Err(error);
                }
                if let [uid] = set {
                    self.isolated.unparseable.push((*uid, error));
                } else {
                    let (low, high) = set.split_at(set.len() / 2);
                    self.pending.push(high);
                    self.pending.push(low);
                }
            }
            Err(error) => return Err(error),
        }
        Ok(())
    }

    pub fn finish(self) -> Isolated<T> {
        self.isolated
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive an isolation against a fake server that returns the requested
    /// UIDs unless the set contains one whose response cannot be parsed.
    /// Returns the outcome and every requested set.
    fn run(
        uids: &[u32],
        bad: &[u32],
        max_failed_attempts: usize,
    ) -> (Result<Isolated<u32>>, Vec<Vec<u32>>) {
        let mut calls = Vec::new();
        let mut isolation = Isolation::new(uids, max_failed_attempts);
        while let Some(set) = isolation.next_set() {
            calls.push(set.to_vec());
            let fetched = if set.iter().any(|uid| bad.contains(uid)) {
                Err(CoreError::ImapParse(
                    "io: unparseable server response".into(),
                ))
            } else {
                Ok(set.to_vec())
            };
            if let Err(error) = isolation.record(set, fetched) {
                return (Err(error), calls);
            }
        }
        (Ok(isolation.finish()), calls)
    }

    fn unparseable(isolated: &Isolated<u32>) -> Vec<u32> {
        let mut uids: Vec<u32> = isolated.unparseable.iter().map(|(uid, _)| *uid).collect();
        uids.sort_unstable();
        uids
    }

    #[test]
    fn one_unparseable_uid_no_longer_fails_its_window() {
        // [Gmail]/Sent Mail history window 732:1231 containing UID 887.
        let window: Vec<u32> = (732..=1231).collect();
        let (result, calls) = run(&window, &[887], MAX_FAILED_ATTEMPTS);
        let isolated = result.expect("window must not fail");

        let mut items = isolated.items.clone();
        items.sort_unstable();
        let expected: Vec<u32> = window.iter().copied().filter(|uid| *uid != 887).collect();
        assert_eq!(items, expected);
        assert_eq!(unparseable(&isolated), vec![887]);
        // Bisection, not one request per UID: ~2 * log2(500) requests.
        assert!(calls.len() <= 2 * 10 + 1, "{} requests", calls.len());
    }

    #[test]
    fn clean_window_is_a_single_request() {
        let window: Vec<u32> = (1..=200).collect();
        let (result, calls) = run(&window, &[], MAX_FAILED_ATTEMPTS);
        assert_eq!(result.unwrap().items.len(), 200);
        assert_eq!(calls, vec![window]);
    }

    #[test]
    fn several_unparseable_uids_are_all_isolated() {
        let window: Vec<u32> = (1..=500).collect();
        let bad = [1, 250, 251, 500];
        let (result, _) = run(&window, &bad, MAX_FAILED_ATTEMPTS);
        let isolated = result.unwrap();
        assert_eq!(isolated.items.len(), 496);
        assert_eq!(unparseable(&isolated), bad);
    }

    #[test]
    fn systemic_parse_failure_is_bounded() {
        let window: Vec<u32> = (1..=500).collect();
        let (result, calls) = run(&window, &window, 32);
        assert!(matches!(result, Err(CoreError::ImapParse(_))));
        assert_eq!(calls.len(), 33);
    }

    #[test]
    fn transport_errors_abort_without_splitting() {
        let window: Vec<u32> = (1..=10).collect();
        let mut isolation = Isolation::<u32>::new(&window, MAX_FAILED_ATTEMPTS);
        let set = isolation.next_set().unwrap();
        assert_eq!(set, window.as_slice());
        let outcome = isolation.record(set, Err(CoreError::Imap("connection lost".into())));
        assert!(matches!(outcome, Err(CoreError::Imap(_))));
    }
}
