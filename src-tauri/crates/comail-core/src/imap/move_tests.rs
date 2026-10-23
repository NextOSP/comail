//! Fake-protocol tests for `uid_move_with`; no network or real mailbox.
use super::*;

struct Fake {
    caps: (bool, bool),
    fail_on: Option<&'static str>,
    calls: Vec<String>,
    /// UIDs flagged \Deleted by someone else; only targeted UID EXPUNGE may
    /// touch them, and it must not touch these.
    unrelated_deleted: Vec<u32>,
    expunged: Vec<u32>,
}

impl Fake {
    fn new(caps: (bool, bool)) -> Self {
        Self {
            caps,
            fail_on: None,
            calls: vec![],
            unrelated_deleted: vec![99],
            expunged: vec![],
        }
    }
    fn step(&mut self, name: &'static str, arg: &str) -> Result<()> {
        self.calls.push(format!("{name} {arg}"));
        if self.fail_on == Some(name) {
            return Err(CoreError::Imap(format!("{name} failed")));
        }
        Ok(())
    }
}

impl MoveOps for Fake {
    async fn capabilities(&mut self) -> Result<(bool, bool)> {
        self.calls.push("CAPABILITY".into());
        Ok(self.caps)
    }
    async fn mv(&mut self, s: &str, t: &str) -> Result<Option<u32>> {
        self.step("MOVE", &format!("{s} {t}"))?;
        Ok(Some(42))
    }
    async fn copy(&mut self, s: &str, t: &str) -> Result<Option<u32>> {
        self.step("COPY", &format!("{s} {t}"))?;
        Ok(Some(42))
    }
    async fn mark_deleted(&mut self, s: &str) -> Result<()> {
        self.step("STORE", s)
    }
    async fn uid_expunge(&mut self, s: &str) -> Result<()> {
        self.step("UID_EXPUNGE", s)?;
        self.expunged.push(s.parse().unwrap());
        Ok(())
    }
}

#[tokio::test]
async fn move_supported_uses_only_move() {
    let mut f = Fake::new((true, true));
    assert_eq!(uid_move_with(&mut f, 5, "Trash").await.unwrap(), Some(42));
    assert_eq!(f.calls, ["CAPABILITY", "MOVE 5 Trash"]);
}

#[tokio::test]
async fn move_error_never_falls_back_to_copy() {
    let mut f = Fake::new((true, true));
    f.fail_on = Some("MOVE");
    assert!(uid_move_with(&mut f, 5, "Trash").await.is_err());
    assert_eq!(f.calls, ["CAPABILITY", "MOVE 5 Trash"]);
}

#[tokio::test]
async fn fallback_uses_targeted_expunge_and_spares_unrelated_deleted() {
    let mut f = Fake::new((false, true));
    assert_eq!(uid_move_with(&mut f, 5, "Trash").await.unwrap(), Some(42));
    assert_eq!(
        f.calls,
        ["CAPABILITY", "COPY 5 Trash", "STORE 5", "UID_EXPUNGE 5"]
    );
    assert_eq!(f.expunged, [5]);
    assert!(!f.expunged.contains(&f.unrelated_deleted[0]));
}

#[tokio::test]
async fn unsupported_capabilities_fail_before_any_mutation() {
    let mut f = Fake::new((false, false));
    let err = uid_move_with(&mut f, 5, "Trash").await.unwrap_err();
    assert!(matches!(err, CoreError::ActionRejected(_)));
    assert_eq!(f.calls, ["CAPABILITY"]);
}

#[tokio::test]
async fn fallback_failure_after_copy_stops_without_expunge() {
    let mut f = Fake::new((false, true));
    f.fail_on = Some("STORE");
    assert!(uid_move_with(&mut f, 5, "Trash").await.is_err());
    assert!(f.expunged.is_empty());
    assert_eq!(f.calls.last().unwrap(), "STORE 5");
}

#[test]
fn plan_prefers_move() {
    assert_eq!(plan_move(true, false).unwrap(), MovePlan::Move);
    assert_eq!(plan_move(false, true).unwrap(), MovePlan::CopyDeleteExpunge);
    assert!(plan_move(false, false).is_err());
}
