// In-memory mock backend so the whole app demos in a plain browser
// (`pnpm dev` without Tauri). Implements every command in the contract.

import type {
  Account,
  ActionResult,
  Address,
  AddPasswordAccountArgs,
  AiStatus,
  AttachmentMeta,
  CalendarEvent,
  Commands,
  ConnectionTestResult,
  ContactSuggestion,
  FolderInfo,
  Label,
  MessageDetail,
  PerformActionArgs,
  QueueSendArgs,
  QueueSendResult,
  SaveDraftArgs,
  SearchArgs,
  Settings,
  Snippet,
  SplitRule,
  SyncStatus,
  ThreadDetail,
  ThreadPage,
  ThreadSummary,
  View,
} from "./types";

export const MOCK_MODE =
  typeof window !== "undefined" &&
  (!("__TAURI_INTERNALS__" in window) || import.meta.env.VITE_MOCK === "1");

// ---------------------------------------------------------------------------
// Fixture state
// ---------------------------------------------------------------------------

type Folder = "inbox" | "done" | "trash" | "spam" | "sent" | "drafts";

interface MockMessage {
  id: number;
  threadId: number;
  accountId: number;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  date: number;
  isRead: boolean;
  isStarred: boolean;
  isDraft: boolean;
  isOutgoing: boolean;
  textBody: string;
  htmlBody: string | null;
  attachments: AttachmentMeta[];
  listUnsubscribe: string | null;
}

interface MockThread {
  id: number;
  accountId: number;
  subject: string;
  folder: Folder;
  isStarred: boolean;
  snoozedUntil: number | null;
  labels: number[];
  messages: MockMessage[];
}

const NOW = Date.now();
const H = 3_600_000;
const D = 24 * H;

let nextId = 1000;
const id = () => nextId++;

const accounts: Account[] = [
  {
    id: 1,
    email: "bd@nextwaves.com",
    displayName: "B.D. Chen",
    provider: "imap",
    authKind: "password",
    syncState: "idle",
  },
  {
    id: 2,
    email: "bd.chen.dev@gmail.com",
    displayName: "B.D. Chen",
    provider: "gmail",
    authKind: "oauth2",
    syncState: "idle",
  },
];

const SELF: Record<number, Address> = {
  1: { name: "B.D. Chen", email: "bd@nextwaves.com" },
  2: { name: "B.D. Chen", email: "bd.chen.dev@gmail.com" },
};

// People
const ana: Address = { name: "Ana Moreau", email: "ana@nextwaves.com" };
const priya: Address = { name: "Priya Raman", email: "priya@nextwaves.com" };
const tom: Address = { name: "Tom Okafor", email: "tom@nextwaves.com" };
const mei: Address = { name: "Mei Nakamura", email: "mei@nextwaves.com" };
const jonas: Address = { name: "Jonas Wehrli", email: "jonas.wehrli@helvetic.io" };
const sofia: Address = { name: "Sofia Lindqvist", email: "sofia@brightline.se" };
const marcus: Address = { name: "Marcus Bell", email: "marcus.bell@atlaslegal.com" };
const elena: Address = { name: "Elena Petrova", email: "elena@quietloop.dev" };
const dad: Address = { name: "Dad", email: "r.chen1958@gmail.com" };
const lea: Address = { name: "Léa Fontaine", email: "lea.fontaine@ensci.fr" };
const dmitri: Address = { name: "Dmitri Kovac", email: "dmitri@ferrous.systems" };

// Automated senders
const github: Address = { name: "GitHub", email: "notifications@github.com" };
const linear: Address = { name: "Linear", email: "notifications@linear.app" };
const stripe: Address = { name: "Stripe", email: "notifications@stripe.com" };
const vercel: Address = { name: "Vercel", email: "notifications@vercel.com" };
const figma: Address = { name: "Figma", email: "no-reply@figma.com" };
const substack: Address = { name: "The Pragmatic Engineer", email: "pragmaticengineer@substack.com" };
const moneyStuff: Address = { name: "Matt Levine (Bloomberg)", email: "noreply@news.bloomberg.com" };
const changelog: Address = { name: "Changelog News", email: "news@changelog.com" };
const amazon: Address = { name: "Amazon.com", email: "shipment-tracking@amazon.com" };
const calendly: Address = { name: "Calendly", email: "no-reply@calendly.com" };
const notion: Address = { name: "Notion", email: "team@makernotes.notion.site" };
const digitalocean: Address = { name: "DigitalOcean", email: "billing@digitalocean.com" };
const cloudflare: Address = { name: "Cloudflare", email: "noreply@notify.cloudflare.com" };
const tailscale: Address = { name: "Tailscale", email: "updates@tailscale.com" };
const railsconf: Address = { name: "RustConf", email: "hello@rustconf.com" };
const hn: Address = { name: "Hacker Newsletter", email: "kale@hackernewsletter.com" };
const meetup: Address = { name: "Meetup", email: "info@email.meetup.com" };
const namecheap: Address = { name: "Namecheap", email: "renewals@namecheap.com" };
const duolingo: Address = { name: "Duolingo", email: "hello@duolingo.com" };
const spotify: Address = { name: "Spotify", email: "no-reply@spotify.com" };

const AUTOMATED_LOCALPARTS = /^(no-?reply|notifications?|news(letter)?|updates?|billing|hello|info|team|digest|marketing|renewals|shipment-tracking|kale|pragmaticengineer)/i;
const AUTOMATED_DOMAINS = /(substack\.com|news\.bloomberg\.com|email\.meetup\.com|notify\.cloudflare\.com|notion\.site)$/i;

function isAutomatedSender(a: Address): boolean {
  const [local, domain] = a.email.toLowerCase().split("@");
  return AUTOMATED_LOCALPARTS.test(local) || AUTOMATED_DOMAINS.test(domain ?? "");
}

const threads: MockThread[] = [];

interface MsgSpec {
  from: Address;
  to?: Address[];
  cc?: Address[];
  ago: number; // ms before NOW
  body: string;
  html?: string;
  unread?: boolean;
  outgoing?: boolean;
  attachments?: Array<{ name: string; mime: string; size: number }>;
  listUnsubscribe?: string;
}

function addThread(
  accountId: number,
  subject: string,
  msgs: MsgSpec[],
  opts: { starred?: boolean; folder?: Folder; snoozedUntil?: number | null } = {},
): MockThread {
  const t: MockThread = {
    id: id(),
    accountId,
    subject,
    folder: opts.folder ?? "inbox",
    isStarred: opts.starred ?? false,
    snoozedUntil: opts.snoozedUntil ?? null,
    labels: [],
    messages: [],
  };
  for (const m of msgs) {
    t.messages.push({
      id: id(),
      threadId: t.id,
      accountId,
      from: m.outgoing ? SELF[accountId] : m.from,
      to: m.to ?? [m.outgoing ? m.from : SELF[accountId]],
      cc: m.cc ?? [],
      subject,
      date: NOW - m.ago,
      isRead: m.outgoing ? true : !(m.unread ?? false),
      isStarred: false,
      isDraft: false,
      isOutgoing: m.outgoing ?? false,
      textBody: m.body,
      htmlBody: m.html ?? null,
      attachments: (m.attachments ?? []).map((a) => ({
        id: id(),
        filename: a.name,
        mimeType: a.mime,
        size: a.size,
        isInline: false,
      })),
      listUnsubscribe: m.listUnsubscribe ?? null,
    });
  }
  t.messages.sort((a, b) => a.date - b.date);
  threads.push(t);
  return t;
}

// --- Account 1: work (bd@nextwaves.com) -------------------------------------

addThread(1, "Q3 roadmap review - final deck", [
  {
    from: ana,
    ago: 0.4 * H,
    unread: true,
    body: "Hey B.D.,\n\nAttached is the final deck for tomorrow's roadmap review. I folded in your notes on the sync-engine milestones and pushed the billing work to Q4.\n\nTwo things I'd still like your eyes on:\n\n1. Slide 7 - the headcount ask. Is two backend hires realistic, or should we frame it as one hire plus contractor budget?\n2. Slide 11 - I used your latency numbers from the March benchmark. Are those still current?\n\nIf you can get me comments by 6pm I'll lock it tonight.\n\nAna",
    attachments: [{ name: "q3-roadmap-v4.pdf", mime: "application/pdf", size: 2_431_022 }],
  },
]);

addThread(1, "Re: Sync engine - IDLE reconnect storm on flaky wifi", [
  {
    from: tom,
    ago: 2 * D + 5 * H,
    body: "Seeing something odd in the logs from the beta cohort: when wifi drops for ~10s, some clients open 4-5 parallel IMAP connections on reconnect and the server starts throttling us.\n\nRepro: toggle the network off mid-IDLE, wait, toggle back.\n\nLogs attached. I think the backoff state isn't shared across folder watchers.",
    attachments: [{ name: "idle-reconnect.log", mime: "text/plain", size: 88_213 }],
  },
  {
    from: tom,
    ago: 1 * D + 2 * H,
    body: "Update - confirmed. Each FolderWatcher owns its own ExponentialBackoff, so after a drop they all wake at once. We need a per-account reconnect gate.\n\nSketch:\n\n  reconnect_gate: Semaphore(1) per account\n  jitter: 0..3s before acquiring\n\nHappy to pair on it tomorrow morning?",
  },
  {
    from: SELF[1],
    ago: 22 * H,
    outgoing: true,
    to: [tom],
    body: "Good find. Yes - per-account gate is right, and let's also cap total connections at 3 per account regardless.\n\nPairing works, 9:30 in the hallway room. I'll sketch the semaphore plumbing tonight.",
  },
  {
    from: tom,
    ago: 3 * H,
    unread: true,
    body: "Sketch looks good. One wrinkle: the gate needs to be fair, otherwise the INBOX watcher can starve the archive backfill. tokio's Semaphore is FIFO so we're fine - just don't wrap it in try_acquire loops.\n\nSee you at 9:30.",
  },
]);

addThread(1, "Offer letter - senior backend engineer (Rina Sato)", [
  {
    from: priya,
    ago: 5 * H,
    unread: true,
    body: "B.D.,\n\nRina accepted verbally this morning. Legal needs your sign-off on the equity band before we send the letter - she's asking for the top of band 4 which is 0.35%.\n\nGiven her Postgres replication work at her last gig I think she's worth it, but it does set a precedent for the other backend req.\n\nCan you approve by EOD? Letter template is in the drive.\n\nPriya",
  },
], { starred: true });

addThread(1, "Customer escalation: Meridian Health - export stuck at 91%", [
  {
    from: mei,
    ago: 1 * D + 8 * H,
    body: "Meridian's compliance export has been stuck at 91% for two days. They have an audit Friday. Support ticket #4821.\n\nFrom the worker logs it looks like one mailbox has a 4GB mbox with a malformed MIME boundary and the parser is spinning.\n\nWho owns the exporter these days?",
  },
  {
    from: SELF[1],
    ago: 1 * D + 6 * H,
    outgoing: true,
    to: [mei],
    cc: [tom],
    body: "That's ours. Tom, can you add a boundary sanity check + skip-and-log for malformed parts? We should never spin on bad input.\n\nMei - tell them Friday is safe. If the fix isn't in by Thursday noon we'll run their export manually from a patched worker.",
  },
  {
    from: mei,
    ago: 26 * H,
    body: "Told them, they're relieved. They also asked (again) about SSO - putting it in the notes for the Q3 call.",
  },
], { starred: true });

addThread(1, "Board update draft - June", [
  {
    from: ana,
    ago: 3 * D + 2 * H,
    body: "Draft of the June board update is here: https://docs.nextwaves.com/board/2026-06\n\nRevenue section is done. Can you write the eng section? Keep it to ~150 words - wins, misses, and the reliability numbers. Deadline Thursday.",
  },
], {});

addThread(1, "Re: Dinner Thursday?", [
  {
    from: jonas,
    ago: 4 * D + 6 * H,
    body: "You're in town for the infra summit right? A few of us are doing dinner Thursday at that Georgian place near Hauptbahnhof - 7pm. Nino's, I think. You should come.",
  },
  {
    from: SELF[1],
    ago: 4 * D + 3 * H,
    outgoing: true,
    to: [jonas],
    body: "In. I land at 4, so 7 is perfect. Is Dmitri coming? Want to corner him about the mail parser benchmarks.",
  },
  {
    from: jonas,
    ago: 4 * D + 1 * H,
    body: "He is now - I forwarded him your benchmark question and he says, quote, 'tell B.D. to bring numbers, not vibes'. See you Thursday.",
  },
]);

addThread(1, "Pen test report - action items (3 high, 7 medium)", [
  {
    from: marcus,
    ago: 5 * D + 4 * H,
    body: "Full report attached. The three highs:\n\nH-1: OAuth state parameter not bound to session (CSRF on account linking)\nH-2: Draft attachments readable via predictable IDs before send\nH-3: Rate limiting absent on the password reset endpoint\n\nWe need written remediation timelines for the SOC 2 evidence folder within two weeks. Mediums can wait for the quarterly cycle.\n\nMarcus Bell\nAtlas Legal & Compliance",
    attachments: [{ name: "nextwaves-pentest-2026H1.pdf", mime: "application/pdf", size: 5_113_400 }],
  },
  {
    from: SELF[1],
    ago: 4 * D + 20 * H,
    outgoing: true,
    to: [marcus],
    cc: [ana],
    body: "Thanks Marcus. H-1 and H-3 are patched in staging already; H-2 needs a storage-layer change, ETA next Friday. Written timeline doc to follow Monday.",
  },
], { starred: true });

addThread(1, "Interview loop feedback needed - candidate #219", [
  {
    from: priya,
    ago: 8 * H,
    unread: true,
    body: "Your feedback for yesterday's systems interview is the last one missing. Debrief is at 3pm today - please get it in before then. Scorecard link: https://ats.nextwaves.com/candidates/219/feedback",
  },
]);

addThread(1, "Hallway room double-booked every Tuesday", [
  {
    from: mei,
    ago: 6 * D + 3 * H,
    body: "FYI the hallway room shows free in the calendar but facilities has it blocked for cleaning 9-10 every Tuesday. I've asked them to put it in the system properly. Moving our Tuesday sync to the fishbowl.",
  },
]);

addThread(1, "Re: Quietloop acquisition - technical due diligence", [
  {
    from: elena,
    ago: 2 * D + 1 * H,
    body: "Hi B.D.,\n\nFollowing up on the call - here's the data room access for the sync-engine due diligence. Codebase snapshot, architecture docs, and the load test results are all in there.\n\nOne correction from the call: our IDLE fan-out is per-folder, not per-account, so the numbers you saw are worst-case.\n\nHappy to walk your team through the CRDT layer whenever.\n\nElena",
  },
  {
    from: SELF[1],
    ago: 1 * D + 20 * H,
    outgoing: true,
    to: [elena],
    body: "Got access, thanks. The CRDT walkthrough would be useful - Tuesday or Wednesday afternoon next week? I'll bring Tom.",
  },
  {
    from: elena,
    ago: 7 * H,
    unread: true,
    body: "Wednesday 2pm works. Calendar invite sent. I'll have our merge-conflict corpus ready - some of the edge cases are genuinely cursed and you should see them before you price this.",
  },
], { starred: true });

addThread(1, "Expense report rejected: 'Team dinner - Berlin'", [
  {
    from: { name: "Nextwaves Finance", email: "finance@nextwaves.com" },
    ago: 3 * D + 7 * H,
    body: "Your expense report EXP-1187 (€214.50, Team dinner - Berlin) was rejected.\n\nReason: itemized receipt missing (credit card slip only).\n\nPlease re-submit with the itemized receipt within 30 days.",
  },
]);

addThread(1, "Notes from the reliability retro", [
  {
    from: tom,
    ago: 7 * D + 2 * H,
    body: "Notes from today's retro:\n\n- The March 30 outage was DNS TTL + our own connection pinning. Action: honor TTLs, cap connection age at 15m. (me)\n- Alert fatigue: 40% of pages last month were the flaky bodies-backfill alert. Action: make it a ticket, not a page. (Mei)\n- We STILL don't have a staging IMAP server that simulates Yahoo's quirks. Action: budget ask. (B.D.)\n\nFull doc: https://docs.nextwaves.com/retro/2026-06-reliability",
  },
]);

addThread(1, "Sabbatical dates - September", [
  {
    from: mei,
    ago: 9 * D + 5 * H,
    body: "As discussed in our 1:1 - formally requesting my sabbatical for Sep 1 to Oct 15. Priya says it's fine on her end if you approve coverage. Tom has agreed to take the on-call rotation lead.",
  },
  {
    from: SELF[1],
    ago: 9 * D + 1 * H,
    outgoing: true,
    to: [mei],
    body: "Approved - you've more than earned it. Let's do a handoff doc the last week of August. And actually unplug this time.",
  },
]);

addThread(1, "Your invoice from Hetzner (2026-06)", [
  {
    from: { name: "Hetzner Online", email: "no-reply@hetzner.com" },
    ago: 8 * D + 9 * H,
    body: "Dear Customer,\n\nYour invoice R0012845772 for June 2026 is available in your account.\n\nAmount due: €1,842.60\nDue date: 2026-07-15\n\nHetzner Online GmbH",
  },
]);

addThread(1, "[nextwaves/sync-engine] PR #612: Per-account reconnect gate (opened)", [
  {
    from: github,
    ago: 2 * H,
    unread: true,
    body: "tom-okafor opened pull request #612 in nextwaves/sync-engine\n\nPer-account reconnect gate\n\nAdds a fair semaphore per account guarding IMAP reconnects, with 0-3s jitter. Fixes the reconnect storm reported in #598.\n\n+214 −38, 6 files changed\n\nView it on GitHub: https://github.com/nextwaves/sync-engine/pull/612",
  },
]);

addThread(1, "[nextwaves/sync-engine] Issue #598: Reconnect storm after network blip", [
  {
    from: github,
    ago: 2 * D + 4 * H,
    body: "mei-nakamura commented on issue #598\n\n> Adding server-side evidence: Fastmail throttled us 11 times last week, all within 30s of a client reconnect burst.\n\nReply to this email directly or view it on GitHub.",
  },
  {
    from: github,
    ago: 1 * H,
    unread: true,
    body: "tom-okafor closed issue #598 as completed via #612.\n\nReply to this email directly or view it on GitHub.",
  },
]);

addThread(1, "LIN-482: Snooze wake-ups fire twice when laptop sleeps past wake time", [
  {
    from: linear,
    ago: 11 * H,
    unread: true,
    body: "Mei Nakamura assigned LIN-482 to you.\n\nSnooze wake-ups fire twice when laptop sleeps past wake time\n\nPriority: High · Cycle 14\n\nWhen the machine sleeps through a snooze wake time, the catch-up scan re-fires notifications that the pre-sleep tick already delivered.\n\nView in Linear: https://linear.app/nextwaves/issue/LIN-482",
  },
]);

addThread(1, "Your Stripe invoice payment failed", [
  {
    from: stripe,
    ago: 1 * D + 3 * H,
    unread: true,
    body: "A payment for invoice in_1PZk8q2 ($480.00) to Nextwaves Inc. failed.\n\nCustomer: meridianhealth.example.com\nReason: card_declined (insufficient_funds)\n\nStripe will retry automatically in 3 days. You can also update the customer's payment method from the dashboard.",
    html: "<div style='font-family:sans-serif;max-width:560px'><h2 style='color:#635bff;margin:0 0 12px'>Stripe</h2><p>A payment for invoice <b>in_1PZk8q2</b> ($480.00) to <b>Nextwaves Inc.</b> failed.</p><table style='border-collapse:collapse;margin:12px 0'><tr><td style='padding:4px 12px 4px 0;color:#666'>Customer</td><td>meridianhealth.example.com</td></tr><tr><td style='padding:4px 12px 4px 0;color:#666'>Reason</td><td>card_declined (insufficient_funds)</td></tr></table><p>Stripe will retry automatically in 3 days.</p><p><a href='https://dashboard.stripe.com' style='color:#635bff'>View in dashboard →</a></p></div>",
  },
]);

addThread(1, "Deployment failed: sync-engine-worker (production)", [
  {
    from: vercel,
    ago: 5 * D + 11 * H,
    body: "Your deployment sync-engine-worker@c41f2aa failed to build.\n\nError: error[E0308]: mismatched types, src/backfill.rs:214\n\nView the build logs: https://vercel.com/nextwaves/sync-engine-worker",
  },
]);

addThread(1, "Priya Raman has scheduled: Backend hiring sync", [
  {
    from: calendly,
    ago: 10 * D + 2 * H,
    body: "A new event has been scheduled.\n\nEvent: Backend hiring sync\nWith: Priya Raman\nWhen: Thursday, 10:00 - 10:30 (Europe/Berlin)\nWhere: Google Meet (link in invite)",
  },
]);

addThread(1, "Your DigitalOcean invoice for June 2026", [
  {
    from: digitalocean,
    ago: 9 * D + 8 * H,
    body: "Your invoice for June 2026 is now available.\n\nTotal: $342.18\n\nDroplets: $268.00\nSpaces: $41.30\nBandwidth overage: $32.88\n\nThis amount will be charged to your card on file.",
  },
]);

addThread(1, "Weekly digest: nextwaves.com zone activity", [
  {
    from: cloudflare,
    ago: 4 * D + 9 * H,
    body: "Here's what happened on nextwaves.com this week:\n\nRequests: 4.2M (+8%)\nThreats blocked: 12,406\nCache hit ratio: 91.2%\nTop country: United States (38%)",
  },
]);

addThread(1, "Tailscale: new device added to your tailnet", [
  {
    from: tailscale,
    ago: 6 * D + 7 * H,
    body: "A new device 'bd-framework-16' was added to the nextwaves.com tailnet by bd@nextwaves.com.\n\nOS: Linux 6.9\nIf this wasn't you, remove the device and rotate your keys immediately.",
  },
]);

addThread(1, "The Pragmatic Engineer: The Reliability Org at Scale", [
  {
    from: substack,
    ago: 1 * D + 1 * H,
    unread: true,
    listUnsubscribe:
      "<https://pragmaticengineer.substack.com/action/disable_email?token=mock123>, <mailto:unsubscribe@substack.com>",
    body: "THE PRAGMATIC ENGINEER\n\nThe Reliability Org at Scale\n\nHow four companies structure on-call, what a 'you build it, you run it' rollback actually looks like, and why error budgets die in committee.\n\n1. The three shapes of reliability orgs\nPlatform-owned, embedded, and federated. Most companies drift between them...\n\n2. Error budgets in practice\nThe budget is a communication device, not a control system...\n\nRead the full issue online (32 min).",
    html: "<div style='font-family:Georgia,serif;max-width:600px;line-height:1.6'><p style='letter-spacing:2px;font-size:12px;color:#888'>THE PRAGMATIC ENGINEER</p><h1 style='font-size:24px;margin:8px 0'>The Reliability Org at Scale</h1><p><i>How four companies structure on-call, what a 'you build it, you run it' rollback actually looks like, and why error budgets die in committee.</i></p><h3>1. The three shapes of reliability orgs</h3><p>Platform-owned, embedded, and federated. Most companies drift between them without noticing, and the drift is where the pages come from...</p><h3>2. Error budgets in practice</h3><p>The budget is a communication device, not a control system. The moment it becomes a gate, teams start gaming the SLIs...</p><p><a href='#'>Read the full issue online</a> · 32 min</p></div>",
  },
]);

addThread(1, "Money Stuff: The Index Fund Owns You Now", [
  {
    from: moneyStuff,
    ago: 7 * H,
    unread: true,
    listUnsubscribe: "<mailto:unsubscribe@news.bloomberg.com?subject=unsubscribe-moneystuff>",
    body: "Money Stuff\nBy Matt Levine\n\nThe Index Fund Owns You Now\n\nOne thing that I say a lot around here is that the essential trade of modern finance is that you give your money to someone else and they do something with it...\n\nAlso: crypto custody, again; an ETF for everything; people are worried about bond market liquidity.",
  },
]);

addThread(1, "Changelog News #97 - local-first is eating sync", [
  {
    from: changelog,
    ago: 3 * D + 5 * H,
    listUnsubscribe: "<https://changelog.com/~/unsubscribe/news?key=mock-97>",
    body: "Changelog News #97\n\n- local-first is eating sync: three new CRDT libraries this month\n- a Rust IMAP crate benchmark shootout (spoiler: buffer sizes matter more than parsers)\n- the terminal renaissance continues: two new GPU terminals\n- jobs: 14 new roles on the board",
  },
]);

addThread(1, "RustConf 2026: early-bird tickets end Friday", [
  {
    from: railsconf,
    ago: 2 * D + 9 * H,
    body: "Early-bird pricing for RustConf 2026 (Portland, Sep 9-11) ends this Friday.\n\nEarly bird: $399 → Regular: $549\n\nSpeaker lineup drops next week. Workshops on async runtime internals and embedded are already listed.",
  },
]);

addThread(1, "Domain renewal: nextwaves.io expires in 30 days", [
  {
    from: namecheap,
    ago: 5 * D + 2 * H,
    body: "Your domain nextwaves.io expires on 2026-08-10.\n\nAuto-renew: OFF\nRenewal price: $38.88\n\nRenew now to avoid losing the domain.",
  },
]);

addThread(1, "Berlin Systems Meetup - Thursday: 'Taming IMAP in 2026'", [
  {
    from: meetup,
    ago: 8 * D + 4 * H,
    body: "New event from Berlin Systems Programming\n\n'Taming IMAP in 2026' - war stories from building a mail sync engine\nThursday 19:00, c-base\n\n41 attending · 12 spots left",
  },
]);

// A couple of non-inbox fixtures for account 1
addThread(1, "Re: Conference travel budget", [
  {
    from: ana,
    ago: 12 * D + 3 * H,
    body: "Approved - book the flights before prices jump. Keep it under €900 total if you can.",
  },
], { folder: "done" });

addThread(1, "Welcome to Nextwaves - IT onboarding", [
  {
    from: { name: "Nextwaves IT", email: "it@nextwaves.com" },
    ago: 13 * D + 6 * H,
    body: "Your accounts are ready. VPN config attached. Ping #it-help with any issues.",
  },
], { folder: "done" });

addThread(1, "You've won a $500 Amazon gift card (claim within 24h)", [
  {
    from: { name: "Rewards Center", email: "claim@prize-notify.xyz" },
    ago: 2 * D + 2 * H,
    body: "Congratulations! Your email was selected. Click here to claim your $500 gift card before it expires.",
  },
], { folder: "spam" });

addThread(1, "Old draft: notes to self", [
  {
    from: SELF[1],
    ago: 6 * D + 1 * H,
    outgoing: true,
    to: [SELF[1]],
    body: "- ask Marcus about the H-2 storage change\n- benchmark idea: mbox parse throughput vs. buffer size\n- book Lisbon flights",
  },
], { folder: "drafts" });
// mark that message as a draft
threads[threads.length - 1].messages[0].isDraft = true;

addThread(1, "Fwd: Updated W-8BEN forms", [
  {
    from: SELF[1],
    ago: 7 * D + 8 * H,
    outgoing: true,
    to: [marcus],
    body: "Marcus - forwarding the updated forms from finance. Let me know if the treaty section looks right now.",
  },
], { folder: "sent" });

addThread(1, "Waiting on Meridian SSO requirements", [
  {
    from: mei,
    ago: 4 * D + 4 * H,
    body: "Meridian's IT team said they'd send their SSO requirements doc 'within a week'. Snoozing-worthy - nothing to do until it lands.",
  },
], { snoozedUntil: NOW + 3 * D });

// --- Account 2: personal (bd.chen.dev@gmail.com) -----------------------------

addThread(2, "Re: Lisbon in August - flat swap?", [
  {
    from: sofia,
    ago: 10 * H,
    unread: true,
    body: "Ok so I checked with my landlord and a two-week swap is fine on my end. Your place has AC right? Lisbon in August is no joke.\n\nDates that work for me: Aug 8-22 or Aug 15-29. The flat is 5 min from Anjos metro, third floor, lots of light, one very opinionated cat (comes with the flat, non-negotiable).\n\nSofia",
  },
  {
    from: SELF[2],
    ago: 9 * H,
    outgoing: true,
    to: [sofia],
    body: "AC yes, cat allergy no, so we're good. Aug 8-22 works. What does the cat need besides worship?",
  },
  {
    from: sofia,
    ago: 5 * H,
    unread: true,
    body: "Worship, two meals a day, and he sits on the router when he wants attention - just move him, he's bluffing. I'll write up the full handoff doc. Flights booked?",
  },
]);

addThread(2, "Dad - the greenhouse project", [
  {
    from: dad,
    ago: 1 * D + 4 * H,
    unread: true,
    body: "Started clearing the back plot for the greenhouse. Your mother thinks 8x12 is too big, I think she's wrong, you're the tiebreaker.\n\nAlso the laptop is doing the thing again where the cursor jumps. Bring your little screwdriver kit when you visit.\n\nDad",
  },
]);

addThread(2, "Your quietloop.dev PR was merged 🎉", [
  {
    from: elena,
    ago: 3 * D + 8 * H,
    body: "Merged your fix for the tombstone GC race - nice catch, that one's been haunting us since 0.9.\n\nAdded you to CONTRIBUTORS. If you ever want a tour of the uglier parts of the merge layer, say the word.\n\nElena",
  },
  {
    from: SELF[2],
    ago: 3 * D + 6 * H,
    outgoing: true,
    to: [elena],
    body: "Ha - small world, we may be meeting in a very different context soon. Yes to the tour regardless.",
  },
], { starred: true });

addThread(2, "Léa: atelier photos + September dates", [
  {
    from: lea,
    ago: 2 * D + 6 * H,
    body: "Photos from the atelier open day attached! The chair you helped sand is in picture 3 - it survived, people sat on it, nobody died.\n\nSeptember session dates: 5-6 or 19-20. The 19th weekend we're doing steam bending which you said you wanted to try.\n\nLéa",
    attachments: [
      { name: "atelier-01.jpg", mime: "image/jpeg", size: 3_204_113 },
      { name: "atelier-03.jpg", mime: "image/jpeg", size: 2_988_450 },
    ],
  },
]);

addThread(2, "Ferrous Systems training - invoice + materials", [
  {
    from: dmitri,
    ago: 6 * D + 9 * H,
    body: "Invoice for the async internals training attached, and the materials repo is now public: https://github.com/ferrous-systems/async-internals\n\nYou asked about the waker vtable diagram - slide 40, and yes you can reuse it with attribution.\n\nDmitri",
    attachments: [{ name: "invoice-2688.pdf", mime: "application/pdf", size: 182_330 }],
  },
]);

addThread(2, "Your Amazon order has shipped: 'USB-C Hub 8-in-1...'", [
  {
    from: amazon,
    ago: 15 * H,
    unread: true,
    body: "Your package is on its way.\n\nOrder #702-4418329-1: USB-C Hub 8-in-1, Anker 65W charger\nArriving: tomorrow by 8pm\n\nTrack your package: https://amazon.com/track",
  },
]);

addThread(2, "Figma: Ana Moreau invited you to 'Comail brand exploration'", [
  {
    from: figma,
    ago: 2 * D + 3 * H,
    body: "Ana Moreau (ana@nextwaves.com) invited you to edit the file 'Comail brand exploration'.\n\nOpen in Figma: https://figma.com/file/abc123",
  },
]);

addThread(2, "Maker Notes #23: shop-made jigs worth the afternoon", [
  {
    from: notion,
    ago: 4 * D + 2 * H,
    body: "Maker Notes #23\n\nThis week: five shop-made jigs that pay for themselves in an afternoon - a crosscut sled with replaceable zero-clearance inserts, a doweling jig from scrap UHMW, and more.\n\nPlus: reader mailbag on flattening slabs without a router sled.",
  },
]);

addThread(2, "Your week 28 streak report", [
  {
    from: duolingo,
    ago: 1 * D + 9 * H,
    body: "Bonjour B.D.!\n\nYou're on a 194-day streak in French. This week: 640 XP, top 3 in your league.\n\nDon't lose your streak - a 5-minute lesson keeps it alive.",
  },
]);

addThread(2, "Your Discover Weekly is ready", [
  {
    from: spotify,
    ago: 2 * D + 11 * H,
    body: "Your Discover Weekly has been updated with 30 new songs picked for you. This week leans heavily on Japanese jazz fusion - someone's been on a Casiopea kick.",
  },
]);

addThread(2, "Hacker Newsletter #741", [
  {
    from: hn,
    ago: 5 * D + 6 * H,
    body: "#741 - This week's favorites:\n\n- Writing an IMAP server from scratch (and regretting it)\n- The economics of undersea cables\n- Show HN: a keyboard-first email client in the terminal\n- Why your CRDT is slow",
  },
]);

addThread(2, "Reminder: dentist appointment July 15", [
  {
    from: { name: "Praxis Dr. Weber", email: "no-reply@doctolib.de" },
    ago: 8 * D + 1 * H,
    body: "This is a reminder of your appointment:\n\nTuesday, July 15, 11:30\nPraxis Dr. Weber, Torstraße 112\n\nPlease reply CANCEL at least 24h ahead if you cannot attend.",
  },
], { snoozedUntil: NOW + 4 * D });

addThread(2, "Re: telescope - is it still available?", [
  {
    from: { name: "Kleinanzeigen User Markus", email: "m.brenner82@web.de" },
    ago: 11 * D + 5 * H,
    body: "Hi, is the Dobsonian still available? Could pick it up Saturday in Pankow. Would you take 240?",
  },
  {
    from: SELF[2],
    ago: 11 * D + 2 * H,
    outgoing: true,
    to: [{ name: "Kleinanzeigen User Markus", email: "m.brenner82@web.de" }],
    body: "Still available. 260 and it's yours, includes both eyepieces. Saturday after 2pm works.",
  },
], { folder: "done" });

addThread(2, "Photos from Oma's 90th", [
  {
    from: { name: "Tante Ines", email: "ines.chen@gmx.de" },
    ago: 12 * D + 7 * H,
    body: "Finally uploaded all the photos from the party: https://photos.app/oma90\n\nThe one of you and Oma arguing about card games is my favorite.",
  },
], { folder: "done", starred: true });

addThread(2, "URGENT: Your account will be suspended", [
  {
    from: { name: "Apple Support", email: "security@appleid-verify.top" },
    ago: 3 * D + 1 * H,
    body: "Dear customer, unusual sign-in activity detected. Verify your Apple ID within 24 hours or your account will be permanently suspended. Click: http://appleid-verify.top/confirm",
  },
], { folder: "spam" });

addThread(2, "Trip idea: Dolomites hut-to-hut", [
  {
    from: SELF[2],
    ago: 5 * D + 3 * H,
    outgoing: true,
    to: [sofia],
    body: "Random idea for late September: Alta Via 1, hut to hut, 6 days. You in? Huts book out by early August so answer fast.",
  },
], { folder: "sent" });

// ---------------------------------------------------------------------------

const snippets: Snippet[] = [
  {
    id: 1,
    name: "Intro reply",
    shortcut: "intro",
    subject: null,
    bodyText: "Thanks for the intro! Moving you to BCC to spare your inbox.\n\n",
    usageCount: 14,
  },
  {
    id: 2,
    name: "Scheduling",
    shortcut: "sched",
    subject: null,
    bodyText: "Happy to find time - here are a few slots that work on my end (CET):\n\n- Tue 10:00–10:30\n- Wed 14:00–15:00\n- Thu 09:30–10:00\n\nIf none work, grab anything here: https://cal.com/bdchen",
    usageCount: 31,
  },
  {
    id: 3,
    name: "Bug report ask",
    shortcut: "repro",
    subject: null,
    bodyText: "Thanks for the report. To pin this down, could you send:\n\n1. App version (About screen)\n2. Rough time it happened (with timezone)\n3. The log file from Settings → Diagnostics → Export\n",
    usageCount: 8,
  },
  {
    id: 4,
    name: "Polite decline",
    shortcut: "no",
    subject: null,
    bodyText: "Thanks for thinking of me - I have to pass on this one, my plate is full through the quarter. Good luck with it!",
    usageCount: 5,
  },
];

const splits: SplitRule[] = [
  {
    id: 1,
    name: "GitHub",
    position: 0,
    query: { senders: ["@github.com", "@linear.app"] },
  },
  {
    id: 2,
    name: "News",
    position: 1,
    query: { isAutomated: true, senders: ["@substack.com", "@news.bloomberg.com", "@changelog.com", "@hackernewsletter.com"] },
  },
];

const labels: Label[] = [
  { id: 1, name: "Work", color: "#2563eb", keyword: "Work", position: 0 },
  { id: 2, name: "Personal", color: "#16a34a", keyword: "Personal", position: 1 },
  { id: 3, name: "Follow up", color: "#d97706", keyword: "Follow_up", position: 2 },
  // System auto-categories (007 migration seeds)
  { id: 101, name: "Marketing", color: "#e0708a", keyword: "ComailAutoMarketing", position: 1000, isAuto: true },
  { id: 102, name: "News", color: "#5b9dd9", keyword: "ComailAutoNews", position: 1001, isAuto: true },
  { id: 103, name: "Social", color: "#7bc47f", keyword: "ComailAutoSocial", position: 1002, isAuto: true },
  { id: 104, name: "Pitch", color: "#c9a04e", keyword: "ComailAutoPitch", position: 1003, isAuto: true },
];

// Seed a few labels onto existing fixtures so chips + filtering demo out of the box.
if (threads[0]) threads[0].labels = [1, 3];
if (threads[1]) threads[1].labels = [2];
if (threads[3]) threads[3].labels = [1];

/** Mirror of the Rust auto-label classifier, enough for demo fixtures. */
function autoLabelOf(t: MockThread): number | null {
  const sender = threadSender(t);
  const email = sender.email.toLowerCase();
  const domain = email.split("@")[1] ?? "";
  const subject = t.subject.toLowerCase();
  if (/(linkedin\.com|facebookmail\.com|twitter\.com|x\.com|redditmail\.com|discord)/.test(domain))
    return 103;
  if (/substack\.com|beehiiv\.com|bloomberg\.com|changelog\.com|hackernewsletter\.com/.test(domain) ||
      /^(news|newsletter|digest|weekly)/.test(email))
    return 102;
  if (isAutomatedSender(sender) &&
      (/(% off|sale|last chance|free shipping|discount)/.test(subject) ||
       /^(marketing|promo|offers|deals)/.test(email)))
    return 101;
  if (!isAutomatedSender(sender) && /(quick call|partnership|sponsor|demo|collab)/.test(subject))
    return 104;
  return null;
}

function applyAutoLabels() {
  for (const t of threads) {
    t.labels = t.labels.filter((id) => id < 100);
    const auto = autoLabelOf(t);
    if (auto != null && t.folder === "inbox") t.labels.push(auto);
  }
}
applyAutoLabels();

const folders: FolderInfo[] = [
  { id: 1, accountId: 1, imapName: "INBOX", role: "inbox" },
  { id: 2, accountId: 1, imapName: "Archive", role: "archive" },
  { id: 3, accountId: 1, imapName: "Sent", role: "sent" },
  { id: 4, accountId: 1, imapName: "Drafts", role: "drafts" },
  { id: 5, accountId: 1, imapName: "Trash", role: "trash" },
  { id: 6, accountId: 1, imapName: "Spam", role: "spam" },
  { id: 7, accountId: 2, imapName: "INBOX", role: "inbox" },
  { id: 8, accountId: 2, imapName: "[Gmail]/All Mail", role: "archive" },
  { id: 9, accountId: 2, imapName: "[Gmail]/Sent Mail", role: "sent" },
  { id: 10, accountId: 2, imapName: "[Gmail]/Drafts", role: "drafts" },
  { id: 11, accountId: 2, imapName: "[Gmail]/Trash", role: "trash" },
  { id: 12, accountId: 2, imapName: "[Gmail]/Spam", role: "spam" },
];

const DEFAULT_MOCK_SETTINGS: Settings = {
  theme: "system",
  language: "system",
  undoSendSeconds: 10,
  loadRemoteImages: false,
  aiBaseUrl: "https://openrouter.ai/api/v1",
  aiModel: "mock/gpt",
  googleClientId: "",
  googleClientSecret: "",
  msClientId: "",
  msClientSecret: "",
  embeddingBackend: "local",
  embeddingModel: "bge-small-en-v1.5",
  voiceDrafting: false,
  voiceProfile: "",
  voiceLearnedAt: 0,
  notificationsEnabled: true,
  autoAdvance: true,
  autoLabelsEnabled: true,
  signatures: {},
};

let settings: Settings = (() => {
  try {
    const raw = localStorage.getItem("comail:mock-settings");
    if (raw) return { ...DEFAULT_MOCK_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_MOCK_SETTINGS };
})();

// ---------------------------------------------------------------------------
// Calendar events (this week, relative to today)
// ---------------------------------------------------------------------------

const startOfToday = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();

const calendarEvents: CalendarEvent[] = [
  {
    id: id(),
    accountId: 1,
    messageId: null,
    summary: "Team standup",
    location: "Fishbowl",
    organizer: "mei@nextwaves.com",
    startsAt: startOfToday + 9.5 * H,
    endsAt: startOfToday + 9.75 * H,
    allDay: false,
    status: "CONFIRMED",
    method: "REQUEST",
  },
  {
    id: id(),
    accountId: 1,
    messageId: null,
    summary: "CRDT walkthrough - Quietloop data room",
    location: "Google Meet",
    organizer: "elena@quietloop.dev",
    startsAt: startOfToday + 14 * H,
    endsAt: startOfToday + 15 * H,
    allDay: false,
    status: "CONFIRMED",
    method: "REQUEST",
  },
  {
    id: id(),
    accountId: 1,
    messageId: null,
    summary: "Backend hiring sync",
    location: null,
    organizer: "priya@nextwaves.com",
    startsAt: startOfToday + 16 * H,
    endsAt: startOfToday + 16.5 * H,
    allDay: false,
    status: "CANCELLED",
    method: "CANCEL",
  },
  {
    id: id(),
    accountId: 1,
    messageId: null,
    summary: "Infra summit - Berlin",
    location: "CityCube Berlin",
    organizer: null,
    startsAt: startOfToday,
    endsAt: startOfToday + D,
    allDay: true,
    status: "CONFIRMED",
    method: "REQUEST",
  },
  {
    id: id(),
    accountId: 1,
    messageId: null,
    summary: "1:1 with Tom - reconnect gate pairing",
    location: "Hallway room",
    organizer: "tom@nextwaves.com",
    startsAt: startOfToday + D + 9.5 * H,
    endsAt: startOfToday + D + 10.5 * H,
    allDay: false,
    status: "CONFIRMED",
    method: "REQUEST",
  },
  {
    id: id(),
    accountId: 1,
    messageId: null,
    summary: "Dinner at Nino's",
    location: "Nino's, near Hauptbahnhof",
    organizer: "jonas.wehrli@helvetic.io",
    startsAt: startOfToday + 2 * D + 19 * H,
    endsAt: startOfToday + 2 * D + 21.5 * H,
    allDay: false,
    status: "CONFIRMED",
    method: "REQUEST",
  },
  {
    id: id(),
    accountId: 2,
    messageId: null,
    summary: "Dentist - Praxis Dr. Weber",
    location: "Torstraße 112",
    organizer: null,
    startsAt: startOfToday + 4 * D + 11.5 * H,
    endsAt: startOfToday + 4 * D + 12 * H,
    allDay: false,
    status: "CONFIRMED",
    method: "REQUEST",
  },
  {
    id: id(),
    accountId: 1,
    messageId: null,
    summary: "Pentest remediation deadline (H-2)",
    location: null,
    organizer: "marcus.bell@atlaslegal.com",
    startsAt: startOfToday + 6 * D,
    endsAt: startOfToday + 7 * D,
    allDay: true,
    status: "CONFIRMED",
    method: "REQUEST",
  },
];

// ---------------------------------------------------------------------------
// Derived views + helpers
// ---------------------------------------------------------------------------

function snippetOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

function summarize(t: MockThread): ThreadSummary {
  const acc = accounts.find((a) => a.id === t.accountId);
  const seen = new Set<string>();
  const participants: Address[] = [];
  for (const m of t.messages) {
    for (const a of [m.from, ...m.to]) {
      const k = a.email.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        participants.push(a);
      }
    }
  }
  const nonDraft = t.messages.filter((m) => !m.isDraft);
  const last = t.messages[t.messages.length - 1];
  return {
    id: t.id,
    accountId: t.accountId,
    accountEmail: acc?.email ?? "",
    subject: t.subject,
    snippet: snippetOf(last?.textBody ?? ""),
    participants,
    lastMessageAt: last?.date ?? 0,
    messageCount: Math.max(nonDraft.length, 1),
    unreadCount: t.messages.filter((m) => !m.isRead && !m.isOutgoing).length,
    isStarred: t.isStarred,
    hasAttachments: t.messages.some((m) => m.attachments.length > 0),
    snoozedUntil: t.snoozedUntil,
    labels: [...t.labels],
  };
}

function toDetail(m: MockMessage): MessageDetail {
  return {
    id: m.id,
    threadId: m.threadId,
    accountId: m.accountId,
    from: m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    date: m.date,
    isRead: m.isRead,
    isStarred: m.isStarred,
    isDraft: m.isDraft,
    isOutgoing: m.isOutgoing,
    snippet: snippetOf(m.textBody),
    bodyState: "cached",
    textBody: m.textBody,
    htmlBody: m.htmlBody,
    attachments: m.attachments,
    listUnsubscribe: m.listUnsubscribe,
  };
}

function threadSender(t: MockThread): Address {
  const incoming = t.messages.filter((m) => !m.isOutgoing);
  return (incoming[incoming.length - 1] ?? t.messages[t.messages.length - 1]).from;
}

function matchesSplitRule(t: MockThread, rule: SplitRule): boolean {
  const sender = threadSender(t);
  const email = sender.email.toLowerCase();
  const q = rule.query;
  if (q.senders?.some((s) => email.endsWith(s.toLowerCase()) || email === s.toLowerCase())) return true;
  if (q.subjectContains?.some((s) => t.subject.toLowerCase().includes(s.toLowerCase()))) return true;
  if (q.isAutomated && isAutomatedSender(sender)) return true;
  return false;
}

function matchesAnyCustomSplit(t: MockThread): boolean {
  return splits.some((r) => matchesSplitRule(t, r));
}

/**
 * splitId convention (mock + suggested for Rust):
 *   -1 = implicit "Important" (not automated, not matched by any custom split)
 *   -2 = implicit "Other" (automated, not matched by any custom split)
 *   >0 = custom SplitRule id
 *   null/undefined = whole view, no split filtering
 */
function inSplit(t: MockThread, splitId: number | null | undefined): boolean {
  if (splitId == null) return true;
  if (splitId > 0) {
    const rule = splits.find((r) => r.id === splitId);
    return rule ? matchesSplitRule(t, rule) : false;
  }
  if (matchesAnyCustomSplit(t)) return false;
  const automated = isAutomatedSender(threadSender(t));
  return splitId === -1 ? !automated : automated;
}

function inView(t: MockThread, view: View): boolean {
  const snoozed = t.snoozedUntil != null && t.snoozedUntil > Date.now();
  switch (view) {
    case "inbox":
      return t.folder === "inbox" && !snoozed;
    case "starred":
      return t.isStarred && t.folder !== "trash" && t.folder !== "spam";
    case "snoozed":
      return snoozed && t.folder !== "trash" && t.folder !== "spam";
    case "sent":
      return t.messages.some((m) => m.isOutgoing && !m.isDraft) && t.folder !== "trash" && t.folder !== "spam";
    case "drafts":
      return t.messages.some((m) => m.isDraft) && t.folder !== "trash";
    case "done":
      return t.folder === "done";
    case "trash":
      return t.folder === "trash";
    case "spam":
      return t.folder === "spam";
    case "all":
      return t.folder !== "trash" && t.folder !== "spam";
  }
}

function delay<T>(v: T, ms = 25 + Math.random() * 45): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(v), ms));
}

// ---------------------------------------------------------------------------
// Mutations, undo log, send queue
// ---------------------------------------------------------------------------

interface UndoEntry {
  actionIds: number[];
  restore: () => void;
}
const undoLog: UndoEntry[] = [];

function snapshotThreads(ids: number[]): () => void {
  const snaps = ids
    .map((tid) => threads.find((t) => t.id === tid))
    .filter((t): t is MockThread => !!t)
    .map((t) => ({
      t,
      folder: t.folder,
      isStarred: t.isStarred,
      snoozedUntil: t.snoozedUntil,
      labels: [...t.labels],
      read: t.messages.map((m) => m.isRead),
    }));
  return () => {
    for (const s of snaps) {
      s.t.folder = s.folder;
      s.t.isStarred = s.isStarred;
      s.t.snoozedUntil = s.snoozedUntil;
      s.t.labels = [...s.labels];
      s.t.messages.forEach((m, i) => (m.isRead = s.read[i] ?? m.isRead));
    }
  };
}

function performAction(args: PerformActionArgs): ActionResult {
  const restore = snapshotThreads(args.threadIds);
  const actionIds = args.threadIds.map(() => id());
  for (const tid of args.threadIds) {
    const t = threads.find((x) => x.id === tid);
    if (!t) continue;
    switch (args.kind) {
      case "mark_read":
        t.messages.forEach((m) => (m.isRead = true));
        break;
      case "mark_unread": {
        const lastIn = [...t.messages].reverse().find((m) => !m.isOutgoing) ?? t.messages[t.messages.length - 1];
        if (lastIn) lastIn.isRead = false;
        break;
      }
      case "star":
        t.isStarred = true;
        break;
      case "unstar":
        t.isStarred = false;
        break;
      case "archive":
        t.folder = "done";
        t.snoozedUntil = null;
        break;
      case "unarchive":
        t.folder = "inbox";
        break;
      case "trash":
        t.folder = "trash";
        t.snoozedUntil = null;
        break;
      case "spam":
        t.folder = "spam";
        break;
      case "not_spam":
        t.folder = "inbox";
        break;
      case "snooze":
        t.snoozedUntil = args.params?.wakeAt ?? Date.now() + D;
        if (t.folder !== "inbox") t.folder = "inbox";
        break;
      case "unsnooze":
        t.snoozedUntil = null;
        break;
      case "move":
        // folders are opaque in the mock; treat as archive
        t.folder = "done";
        break;
      case "add_label":
        if (args.params?.labelId != null && !t.labels.includes(args.params.labelId)) {
          t.labels = [...t.labels, args.params.labelId];
        }
        break;
      case "remove_label":
        if (args.params?.labelId != null) {
          t.labels = t.labels.filter((l) => l !== args.params!.labelId);
        }
        break;
    }
  }
  undoLog.push({ actionIds, restore });
  return { actionIds };
}

interface PendingSend {
  actionId: number;
  draftId: number;
  timer: ReturnType<typeof setTimeout>;
}
const pendingSends = new Map<number, PendingSend>();

interface DraftLoc {
  threadId: number;
  messageId: number;
}
const draftIndex = new Map<number, DraftLoc>();

function saveDraft(args: SaveDraftArgs): { draftId: number } {
  let loc = args.draftId != null ? draftIndex.get(args.draftId) : undefined;
  let thread: MockThread | undefined;
  let msg: MockMessage | undefined;

  if (loc) {
    thread = threads.find((t) => t.id === loc!.threadId);
    msg = thread?.messages.find((m) => m.id === loc!.messageId);
  }

  if (!msg) {
    // Locate the thread (reply/forward attach to the original thread)
    if (args.inReplyToMessageId != null) {
      thread = threads.find((t) => t.messages.some((m) => m.id === args.inReplyToMessageId));
    }
    if (!thread) {
      thread = {
        id: id(),
        accountId: args.accountId,
        subject: args.subject || "(no subject)",
        folder: "drafts",
        isStarred: false,
        snoozedUntil: null,
        labels: [],
        messages: [],
      };
      threads.push(thread);
    }
    msg = {
      id: id(),
      threadId: thread.id,
      accountId: args.accountId,
      from: SELF[args.accountId] ?? { name: null, email: "me@example.com" },
      to: args.to,
      cc: args.cc,
      subject: args.subject || thread.subject,
      date: Date.now(),
      isRead: true,
      isStarred: false,
      isDraft: true,
      isOutgoing: true,
      textBody: args.bodyText,
      htmlBody: null,
      attachments: [],
      listUnsubscribe: null,
    };
    thread.messages.push(msg);
    loc = { threadId: thread.id, messageId: msg.id };
    draftIndex.set(msg.id, loc);
  } else {
    msg.to = args.to;
    msg.cc = args.cc;
    msg.subject = args.subject || msg.subject;
    msg.textBody = args.bodyText;
    msg.date = Date.now();
    if (thread && thread.folder === "drafts") thread.subject = args.subject || thread.subject;
  }
  // Staged files replace the draft's attachment set on every save.
  msg.attachments = (args.attachments ?? []).map((a) => ({
    id: id(),
    filename: a.filename,
    mimeType: null,
    size: null,
    isInline: false,
  }));
  return { draftId: msg.id };
}

function dispatchSend(draftId: number) {
  const loc = draftIndex.get(draftId);
  if (!loc) return;
  const t = threads.find((x) => x.id === loc.threadId);
  const m = t?.messages.find((x) => x.id === loc.messageId);
  if (!t || !m) return;
  m.isDraft = false;
  m.date = Date.now();
  if (t.folder === "drafts") t.folder = "sent";
  draftIndex.delete(draftId);
}

function deleteDraft(draftId: number) {
  const loc = draftIndex.get(draftId);
  if (!loc) return;
  const t = threads.find((x) => x.id === loc.threadId);
  if (t) {
    t.messages = t.messages.filter((m) => m.id !== loc.messageId);
    if (t.messages.length === 0) {
      const i = threads.indexOf(t);
      if (i >= 0) threads.splice(i, 1);
    }
  }
  draftIndex.delete(draftId);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function searchThreads(args: SearchArgs): ThreadSummary[] {
  const limit = args.limit ?? 50;
  let unreadOnly = false;
  let starredOnly = false;
  let attachOnly = false;
  let fromFilter: string | null = null;
  let viewFilter: View | null = null;
  const terms: string[] = [];

  for (const tok of args.query.trim().split(/\s+/).filter(Boolean)) {
    const lower = tok.toLowerCase();
    if (lower.startsWith("from:")) fromFilter = lower.slice(5);
    else if (lower === "is:unread") unreadOnly = true;
    else if (lower === "is:starred") starredOnly = true;
    else if (lower === "has:attachment") attachOnly = true;
    else if (lower.startsWith("in:")) {
      const v = lower.slice(3);
      const map: Record<string, View> = {
        inbox: "inbox", starred: "starred", snoozed: "snoozed", sent: "sent",
        drafts: "drafts", done: "done", archive: "done", trash: "trash", spam: "spam", all: "all",
      };
      viewFilter = map[v] ?? null;
    } else terms.push(foldText(lower));
  }

  // Two tiers, like the backend: threads matching every term win; when none
  // do, fall back to threads matching any term.
  const exact: ThreadSummary[] = [];
  const loose: ThreadSummary[] = [];
  const sorted = [...threads].sort(
    (a, b) => (b.messages[b.messages.length - 1]?.date ?? 0) - (a.messages[a.messages.length - 1]?.date ?? 0),
  );
  for (const t of sorted) {
    if (exact.length >= limit) break;
    if (viewFilter && !inView(t, viewFilter)) continue;
    if (!viewFilter && (t.folder === "trash" || t.folder === "spam")) continue;
    const s = summarize(t);
    if (unreadOnly && s.unreadCount === 0) continue;
    if (starredOnly && !s.isStarred) continue;
    if (attachOnly && !s.hasAttachments) continue;
    if (fromFilter) {
      const hit = t.messages.some(
        (m) =>
          m.from.email.toLowerCase().includes(fromFilter!) ||
          (m.from.name ?? "").toLowerCase().includes(fromFilter!),
      );
      if (!hit) continue;
    }
    if (terms.length > 0) {
      const folded = foldText(
        [
          t.subject,
          ...t.messages.map((m) => m.textBody),
          ...t.messages.map((m) => `${m.from.name ?? ""} ${m.from.email}`),
        ].join("\n"),
      );
      if (!terms.every((term) => folded.includes(term))) {
        if (loose.length < limit && terms.some((term) => folded.includes(term))) loose.push(s);
        continue;
      }
    }
    exact.push(s);
  }
  return exact.length > 0 ? exact : loose;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

function allContacts(): Address[] {
  const seen = new Map<string, Address>();
  for (const t of threads) {
    for (const m of t.messages) {
      for (const a of [m.from, ...m.to, ...m.cc]) {
        const k = a.email.toLowerCase();
        if (!seen.has(k) && !accounts.some((acc) => acc.email.toLowerCase() === k)) {
          seen.set(k, a);
        } else if (seen.has(k) && a.name && !seen.get(k)!.name) {
          seen.set(k, a);
        }
      }
    }
  }
  return [...seen.values()];
}

/** Lowercase + strip diacritics, mirroring the backend's accent-insensitive fold. */
function foldText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/** Contacts where every folded query token matches, ranked by message count. */
function suggestContacts(query: string, limit: number): ContactSuggestion[] {
  const tokens = foldText(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const counts = new Map<string, number>();
  for (const t of threads) {
    for (const m of t.messages) {
      const k = m.from.email.toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return allContacts()
    .map((c) => ({
      name: c.name,
      email: c.email,
      interactions: counts.get(c.email.toLowerCase()) ?? 1,
    }))
    .filter((c) => {
      const hay = foldText(`${c.name ?? ""} ${c.email}`);
      return tokens.every((tok) => hay.includes(tok));
    })
    .sort((x, y) => y.interactions - x.interactions)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

type CmdName = keyof Commands;

export async function mockInvoke(cmd: CmdName, args: unknown): Promise<unknown> {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (cmd) {
    case "list_accounts":
      return delay(accounts.map((x) => ({ ...x })));

    case "test_connection": {
      const t = (a.args ?? {}) as AddPasswordAccountArgs;
      if (!t.imapHost || !t.password) {
        return delay<ConnectionTestResult>({ ok: false, error: "Missing host or password" }, 500);
      }
      if (/fail/i.test(t.password)) {
        return delay<ConnectionTestResult>({ ok: false, error: "IMAP authentication failed (AUTHENTICATIONFAILED)" }, 700);
      }
      return delay<ConnectionTestResult>({ ok: true, error: null }, 700);
    }

    case "add_account_password": {
      const t = (a.args ?? {}) as AddPasswordAccountArgs;
      const acc: Account = {
        id: accounts.length + 1,
        email: t.email,
        displayName: t.displayName,
        provider: "imap",
        authKind: "password",
        syncState: "syncing",
      };
      accounts.push(acc);
      SELF[acc.id] = { name: t.displayName, email: t.email };
      setTimeout(() => (acc.syncState = "idle"), 4000);
      return delay({ ...acc }, 400);
    }

    case "remove_account": {
      const i = accounts.findIndex((x) => x.id === a.accountId);
      if (i >= 0) accounts.splice(i, 1);
      return delay(undefined);
    }

    case "start_oauth":
      await delay(null, 600);
      throw new Error("OAuth sign-in isn't available in this build yet - use IMAP/SMTP for now.");

    case "list_threads": {
      const view = (a.view as View) ?? "inbox";
      const splitId = a.splitId as number | null | undefined;
      const accountId = a.accountId as number | null | undefined;
      const labelId = a.labelId as number | null | undefined;
      const cursor = (a.cursor as number | null | undefined) ?? 0;
      const limit = (a.limit as number | undefined) ?? 30;
      const matched = threads
        .filter((t) => inView(t, view))
        .filter((t) => (view === "inbox" ? inSplit(t, splitId) : true))
        .filter((t) => (accountId == null ? true : t.accountId === accountId))
        .filter((t) => (labelId == null ? true : t.labels.includes(labelId)))
        .map(summarize)
        .sort((x, y) => (view === "snoozed" ? (x.snoozedUntil ?? 0) - (y.snoozedUntil ?? 0) : y.lastMessageAt - x.lastMessageAt));
      const page = matched.slice(cursor, cursor + limit);
      const next = cursor + limit < matched.length ? cursor + limit : null;
      return delay<ThreadPage>({ threads: page, nextCursor: next });
    }

    case "get_thread": {
      const t = threads.find((x) => x.id === a.threadId);
      if (!t) throw new Error(`Thread ${a.threadId} not found`);
      return delay<ThreadDetail>({
        thread: summarize(t),
        messages: t.messages.map(toDetail),
      });
    }

    case "get_body": {
      for (const t of threads) {
        const m = t.messages.find((x) => x.id === a.messageId);
        if (m) return delay(toDetail(m));
      }
      throw new Error(`Message ${a.messageId} not found`);
    }

    case "get_attachment":
      return delay(`/tmp/comail-mock/attachment-${a.attachmentId}`);

    case "list_folders":
      return delay(folders.filter((f) => (a.accountId == null ? true : f.accountId === a.accountId)));

    case "perform_action":
      return delay(performAction(a.args as PerformActionArgs));

    case "undo_last": {
      const e = undoLog.pop();
      if (e) e.restore();
      return delay({ undone: !!e });
    }

    case "cancel_send": {
      const p = [...pendingSends.values()].find((x) => x.actionId === a.actionId);
      if (p) {
        clearTimeout(p.timer);
        pendingSends.delete(p.draftId);
        return delay({ cancelled: true });
      }
      return delay({ cancelled: false });
    }

    case "save_draft":
      return delay(saveDraft(a.args as SaveDraftArgs));

    case "delete_draft":
      deleteDraft(a.draftId as number);
      return delay(undefined);

    case "queue_send": {
      const q = a.args as QueueSendArgs;
      const dispatchAt = q.sendAt ?? Date.now() + settings.undoSendSeconds * 1000;
      const actionId = id();
      const timer = setTimeout(() => {
        dispatchSend(q.draftId);
        pendingSends.delete(q.draftId);
      }, Math.max(0, dispatchAt - Date.now()));
      pendingSends.set(q.draftId, { actionId, draftId: q.draftId, timer });
      return delay<QueueSendResult>({ actionId, dispatchAt });
    }

    case "list_contacts": {
      const prefix = ((a.prefix as string) ?? "").toLowerCase();
      const limit = (a.limit as number | undefined) ?? 8;
      const hits = allContacts().filter(
        (c) => c.email.toLowerCase().includes(prefix) || (c.name ?? "").toLowerCase().includes(prefix),
      );
      hits.sort((x, y) => {
        const xs = x.email.toLowerCase().startsWith(prefix) || (x.name ?? "").toLowerCase().startsWith(prefix) ? 0 : 1;
        const ys = y.email.toLowerCase().startsWith(prefix) || (y.name ?? "").toLowerCase().startsWith(prefix) ? 0 : 1;
        return xs - ys;
      });
      return delay(hits.slice(0, limit));
    }

    case "suggest_contacts":
      return delay(suggestContacts((a.query as string) ?? "", (a.limit as number | undefined) ?? 4));

    case "search":
      return delay(searchThreads(a.args as SearchArgs), 60);

    case "list_snippets":
      return delay(snippets.map((s) => ({ ...s })));

    case "save_snippet": {
      const s = a.snippet as Omit<Snippet, "id" | "usageCount"> & { id: number | null };
      if (s.id != null) {
        const ex = snippets.find((x) => x.id === s.id);
        if (ex) Object.assign(ex, s);
        return delay({ ...(snippets.find((x) => x.id === s.id) ?? s), id: s.id, usageCount: 0 });
      }
      const created: Snippet = { ...s, id: id(), usageCount: 0 };
      snippets.push(created);
      return delay({ ...created });
    }

    case "delete_snippet": {
      const i = snippets.findIndex((x) => x.id === a.snippetId);
      if (i >= 0) snippets.splice(i, 1);
      return delay(undefined);
    }

    case "use_snippet": {
      const s = snippets.find((x) => x.id === a.snippetId);
      if (s) s.usageCount++;
      return delay(undefined);
    }

    case "list_splits":
      return delay(splits.map((s) => ({ ...s, query: { ...s.query } })));

    case "save_split": {
      const s = a.split as Omit<SplitRule, "id"> & { id: number | null };
      if (s.id != null) {
        const ex = splits.find((x) => x.id === s.id);
        if (ex) Object.assign(ex, s);
        return delay({ ...s, id: s.id });
      }
      const created: SplitRule = { ...s, id: id() };
      splits.push(created);
      return delay({ ...created });
    }

    case "delete_split": {
      const i = splits.findIndex((x) => x.id === a.splitId);
      if (i >= 0) splits.splice(i, 1);
      return delay(undefined);
    }

    case "unread_counts": {
      const accId = (a.accountId ?? null) as number | null;
      const pool = threads.filter((t) => accId == null || t.accountId === accId);
      const isUnread = (t: MockThread) =>
        t.messages.some((m) => !m.isRead && !m.isOutgoing);
      const inInbox = (t: MockThread) => inView(t, "inbox");
      const unreadInbox = pool.filter((t) => inInbox(t) && isUnread(t));

      const splitsMap: Record<string, number> = {};
      for (const r of splits) {
        splitsMap[String(r.id)] = unreadInbox.filter((t) => matchesSplitRule(t, r)).length;
      }
      const labelsMap: Record<string, number> = {};
      for (const l of labels) {
        labelsMap[String(l.id)] = unreadInbox.filter((t) => t.labels.includes(l.id)).length;
      }
      return delay({
        inbox: unreadInbox.length,
        important: unreadInbox.filter((t) => inSplit(t, -1)).length,
        other: unreadInbox.filter((t) => inSplit(t, -2)).length,
        splits: splitsMap,
        labels: labelsMap,
        views: {
          starred: pool.filter((t) => inView(t, "starred") && isUnread(t)).length,
          snoozed: pool.filter((t) => inView(t, "snoozed") && isUnread(t)).length,
          drafts: pool.filter((t) => inView(t, "drafts")).length,
        },
      });
    }

    case "relabel_auto": {
      applyAutoLabels();
      const n = threads.filter((t) => t.labels.some((id) => id >= 100)).length;
      return delay(n, 400);
    }

    case "list_labels":
      return delay(labels.map((l) => ({ ...l })));

    case "save_label": {
      const l = a.label as Omit<Label, "id" | "keyword"> & { id: number | null };
      if (l.id != null) {
        const ex = labels.find((x) => x.id === l.id);
        if (ex) {
          ex.name = l.name;
          ex.color = l.color;
          ex.position = l.position;
        }
        return delay({ ...(ex ?? { ...l, id: l.id, keyword: l.name }) });
      }
      const created: Label = {
        id: id(),
        name: l.name,
        color: l.color,
        position: l.position,
        keyword: l.name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Label",
      };
      labels.push(created);
      return delay({ ...created });
    }

    case "delete_label": {
      const i = labels.findIndex((x) => x.id === a.labelId);
      if (i >= 0) labels.splice(i, 1);
      for (const t of threads) t.labels = t.labels.filter((x) => x !== a.labelId);
      return delay(undefined);
    }

    case "sync_now":
      return delay(undefined, 300);

    case "get_sync_status":
      return delay<SyncStatus[]>(accounts.map((x) => ({ accountId: x.id, state: x.syncState, progress: x.syncState === "syncing" ? 0.4 : null })));

    case "get_settings":
      return delay({ ...settings });

    case "set_settings": {
      settings = { ...(a.settings as Settings) };
      try {
        localStorage.setItem("comail:mock-settings", JSON.stringify(settings));
      } catch {
        /* ignore */
      }
      return delay(undefined);
    }

    case "list_events": {
      const startMs = (a.startMs as number) ?? 0;
      const endMs = (a.endMs as number) ?? Number.MAX_SAFE_INTEGER;
      const hits = calendarEvents
        .filter((ev) => ev.startsAt < endMs && (ev.endsAt ?? ev.startsAt) > startMs)
        .sort((x, y) => x.startsAt - y.startsAt)
        .map((ev) => ({ ...ev }));
      return delay(hits, 60);
    }

    case "ai_status":
      return delay<AiStatus>(
        { configured: true, model: settings.aiModel || "mock/gpt", baseUrl: settings.aiBaseUrl },
        80,
      );

    case "set_ai_key":
      return delay(undefined, 150);

    case "ai_list_models":
      return delay(
        ["anthropic/claude-sonnet", "mock/gpt", "openai/gpt-4o-mini", "openai/gpt-4o"],
        200,
      );

    case "ai_summarize": {
      const t = threads.find((x) => x.id === a.threadId);
      if (!t) throw new Error(`Thread ${a.threadId} not found`);
      const who = threadSender(t);
      return delay(
        `${who.name ?? who.email} and ${t.messages.length > 1 ? "others discuss" : "you received"} "${t.subject}" - the key point is agreement on next steps with one open question remaining. You are expected to reply with a decision; nothing else in the thread needs action.`,
        800,
      );
    }

    case "ai_draft": {
      const instruction = (a.instruction as string) ?? "";
      const senderName = (a.senderName as string | null) ?? "me";
      const t = threads.find((x) => x.id === a.threadId);
      const greeting = t ? `Hi ${(threadSender(t).name ?? threadSender(t).email).split(" ")[0]},` : "Hi,";
      return delay(
        `${greeting}\n\nThanks for your note. As requested (${instruction.trim() || "no instruction"}), here's where I've landed: happy to proceed as discussed, and I'll follow up with details shortly.\n\nBest,\n${senderName}`,
        1200,
      );
    }

    case "ai_ask": {
      const question = (a.question as string) ?? "";
      const top = threads.slice(0, 3);
      return delay(
        {
          answer: top.length
            ? `Based on your recent mail, the short answer to "${question.trim() || "your question"}" is: the team agreed on next steps in "${top[0].subject}" [1]${top[1] ? `, with related context in "${top[1].subject}" [2]` : ""}.`
            : "I couldn't find anything relevant in your mailbox.",
          citations: top.map((t) => {
            const last = t.messages[t.messages.length - 1];
            return {
              messageId: last?.id ?? t.id,
              threadId: t.id,
              subject: t.subject,
              from: threadSender(t).name ?? threadSender(t).email,
              date: last?.date ?? NOW,
              snippet: last?.textBody?.slice(0, 120) ?? t.subject,
            };
          }),
        },
        900,
      );
    }

    case "embedding_status":
      return delay(
        {
          enabled: settings.embeddingBackend === "local",
          model: settings.embeddingModel || "bge-small-en-v1.5",
          total: threads.length,
          embedded: threads.length,
          pending: 0,
          ready: settings.embeddingBackend === "local",
        },
        30,
      );

    case "semantic_reindex":
      return delay(threads.length, 50);

    case "ai_learn_voice": {
      const profile =
        "- Greets by first name, signs off with “Cheers”\n" +
        "- Warm but brief; 1–2 short paragraphs\n" +
        "- Rarely uses exclamation marks; no emoji\n" +
        "- Often opens with a quick thanks";
      settings = { ...settings, voiceProfile: profile, voiceLearnedAt: Date.now() };
      return delay(profile, 900);
    }

    default:
      throw new Error(`mockInvoke: unimplemented command "${cmd as string}"`);
  }
}
