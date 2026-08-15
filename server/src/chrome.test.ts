import { describe, expect, it } from 'vitest';
import { clientScript, sessionPage } from './chrome.js';

/**
 * The client script has no build step and no module loader, so a syntax
 * error in it is invisible until a live session — where it silently kills
 * the notes panel, the status header, AND the End Session button at once.
 * Parsing it here is the only cheap guard against that. Now that the script
 * is a real file (client/session.js) rather than an inline template literal,
 * this also proves the page actually references it.
 */
describe('session chrome', () => {
  const html = sessionPage('sess-test');
  const js = clientScript() ?? '';

  it('a disabled voice chip names its cause and the remedy', () => {
    // "voice: off" with no reason read as a broken feature when it was a
    // missing credential — the user could not tell which, or how to fix it.
    expect(html).toContain('no API key');
    expect(html).toContain('ELEVENLABS_API_KEY');
    expect(html).toContain('disabled for this round');
    // And it must say the interviewer still works, so text-only doesn't
    // look like total failure.
    expect(html).toMatch(/interviewer still works/i);
  });

  it('the page has a way home — never strand a graded candidate (QA ISSUE-004)', () => {
    const withBack = sessionPage('sess-test', {
      interviewer: true, time_limit_ms: null, one_shot: false, autorun: true,
      back_url: 'http://localhost:3300/#/t/tid',
    });
    expect(withBack).toContain('id="back"');
    expect(withBack).toContain('← back to plan');
    // The card reuses the header link; the ended layout swallows the dead
    // editor pane.
    expect(js).toContain('cardback');
    expect(withBack).toContain('body.ended main iframe { display: none; }');
  });

  it('the clock and both polls stop when the session ends (QA ISSUE-012)', () => {
    expect(js).toContain('function stopSessionLoops()');
    expect(js).toContain('clearInterval(clockTimer)');
    expect(js).toContain('clearInterval(statusTimer)');
    expect(js).toContain('clearInterval(messagesTimer)');
  });

  it('the workspace folder is per-session, never the constant path (QA ISSUE-005)', () => {
    const v = sessionPage('sess-test', {
      interviewer: true, time_limit_ms: null, one_shot: false, autorun: true,
      workspace_path: '/home/workspace/p-sess-test',
    });
    expect(v).toContain('/?folder=/home/workspace/p-sess-test');
  });

  it('has a parseable client script', () => {
    expect(() => new Function(js)).not.toThrow();
  });

  it('the page loads the extracted client script', () => {
    expect(html).toContain('<script src="/client/session.js"></script>');
  });

  it('polls the endpoints the session runtime actually serves', () => {
    for (const route of ['/api/status', '/api/messages?since=', '/api/utterance', '/api/end']) {
      expect(js).toContain(route);
    }
  });

  it('listens on the /events doorbell and keeps the poll as fallback', () => {
    // A turn used to wait out up to 2s of poll interval before rendering —
    // dead air on every reply. The poke makes the fetch immediate; the poll
    // survives so a dead socket costs immediacy, never delivery.
    expect(js).toContain("'/events'");
    expect(js).toContain('setInterval(pollMessages, 2000)');
    expect(js).toContain('pollInFlight');
  });

  it('tells the candidate what the interviewer will and will not answer', () => {
    expect(html).toContain('interviewer');
    expect(html).toContain("you won't");
  });

  it('tells the candidate the operational definition of going quiet', () => {
    // The observed-panel copy must match what the server actually computes:
    // silence is derived from ALL sources, not keystrokes.
    expect(html).toContain('no activity anywhere');
  });

  it('renders the three assessment states distinctly — none may read as success', () => {
    expect(js).toContain('Session not assessed');          // judge failed
    expect(js).toContain('not assessable this session');   // per-dimension
    expect(js).toContain('Session observations');          // assessed (D1 framing)
  });

  it('gates bug disclosure on solved with an explicit spoiler toggle', () => {
    expect(js).toContain('show me the bug');
    expect(js).toContain('card.solved');
  });

  it('labels unreceipted claims so a verdict without evidence never passes as fact', () => {
    expect(js).toContain('No verifiable citation survived');
  });

  it('serves exactly the allowlisted client files, nothing else', () => {
    expect(clientScript('voice.js')).toContain('startVoice');
    expect(clientScript('presence.js')).toContain('presenceStep');
    expect(clientScript('../session.ts')).toBeNull();
    expect(clientScript('secrets.env')).toBeNull();
  });

  it('boots voice as a module and wires the mute control', () => {
    expect(html).toContain("import { startVoice } from '/client/voice.js'");
    expect(html).toContain('id="mute"');
    expect(html).toContain('id="voicechip"');
  });

  it('plays interviewer audio from the STORED turn seq — the guarded text', () => {
    // The client asks for /voice/tts/<seq>; the server reads that event's
    // payload.text, which guard() produced. No client path carries raw
    // model output to the speaker.
    expect(js).toContain('window.ipVoice.speak(m.seq,');
    expect(clientScript('voice.js')).toContain("'/voice/tts/' + seq");
  });

  it('voice client never sees a vendor key or vendor URL', () => {
    const voice = clientScript('voice.js') ?? '';
    expect(voice).not.toMatch(/elevenlabs|xi-api-key/i);
  });
});

describe('spec-driven session page (capabilities, not format branches)', () => {
  it('an OA view drops the interviewer intro and shows the one-shot rules', () => {
    const html = sessionPage('s', {
      interviewer: false,
      time_limit_ms: 20 * 60_000,
      one_shot: true,
      autorun: false,
    });
    expect(html).toContain('no interviewer this round');
    expect(html).not.toContain('the interviewer only replies');
    expect(html).toContain('>Submit</button>');
    expect(html).toContain('data-limit="1200000"');
    expect(html).toContain('runs ONCE, when you press Submit');
    expect(html).not.toContain('runs once automatically at start');
  });

  it('the default view is exactly the debugging round the product always had', () => {
    const html = sessionPage('s');
    expect(html).toContain('the interviewer only replies');
    expect(html).toContain('>End session</button>');
    expect(html).not.toContain('data-limit');
    expect(html).toContain('runs once automatically at start');
  });

  it('a timed-but-live view keeps the interviewer and gains the countdown', () => {
    const html = sessionPage('s', {
      interviewer: true,
      time_limit_ms: 45 * 60_000,
      one_shot: false,
      autorun: true,
    });
    expect(html).toContain('data-limit="2700000"');
    expect(html).toContain('the interviewer only replies');
    expect(html).toContain('>End session</button>');
  });
});

describe('Run Tests lives in our header, not inside the editor', () => {
  // Observed live: a candidate sat in a session with BOTH IDE affordances
  // present (status-bar item reading "Tests failed — Run again", an
  // unlabeled beaker in the editor title bar) and asked the interviewer
  // how to run tests. The button now sits above the workbench where no
  // focused tab can hide it.
  it('an iterate IDE round gets a labeled accent button in the header', () => {
    const html = sessionPage('s');
    expect(html).toContain('id="run"');
    expect(html).toContain('▶ Run Tests');
    expect(html).toContain('data-endpoint="/api/ide-run"');
    // Above the workbench, not inside it: the button is in <header>.
    expect(html.indexOf('id="run"')).toBeLessThan(html.indexOf('<main>'));
  });

  it('the panes surface uses the same header button, wired to its own route', () => {
    const html = sessionPage('s', { surface: 'panes', statement: 'x' });
    expect(html).toContain('data-endpoint="/api/run"');
    expect(html.indexOf('id="run"')).toBeLessThan(html.indexOf('<main>'));
  });

  it('rounds that cannot iterate have no run button on either surface', () => {
    expect(sessionPage('s', { one_shot: true })).not.toContain('id="run"');
    expect(sessionPage('s', { can_run_tests: false })).not.toContain('id="run"');
    expect(sessionPage('s', { surface: 'panes', one_shot: true, statement: 'x' })).not.toContain('id="run"');
  });

  it('the IDE run path asks the extension to run, never a second runner', () => {
    const js = clientScript() ?? '';
    expect(js).toContain('/api/ide-run');
    expect(js).toContain('ide_not_connected');
  });
});

describe('panes surface (the HackerRank-classic renderer)', () => {
  const oaPanes = () =>
    sessionPage('s', {
      interviewer: false,
      one_shot: true,
      autorun: false,
      surface: 'panes',
      can_run_tests: true,
      statement: 'Implement the reservation ledger.',
      time_limit_ms: 105 * 60_000,
    });

  it('replaces ONLY the workbench mount — no iframe, statement + Monaco instead', () => {
    const html = oaPanes();
    expect(html).not.toContain('/?folder=');
    expect(html).toContain('id="statement"');
    expect(html).toContain('Implement the reservation ledger.');
    expect(html).toContain('/vendor/monaco/loader.js');
    expect(html).toContain('<script src="/client/panes.js"></script>');
    // The shared chrome survives the fork: Submit flow, clock. (The chat
    // aside is interviewer-only since 2026-08-15 — pinned in its own suite.)
    expect(html).toContain('>Submit</button>');
    expect(html).toContain('data-limit="6300000"');
  });

  it('the ide surface is byte-for-byte the page the product always had', () => {
    const html = sessionPage('s', { workspace_path: '/home/workspace/p-s' });
    expect(html).toContain('/?folder=/home/workspace/p-s');
    expect(html).not.toContain('id="statement"');
    expect(html).not.toContain('monaco');
  });

  it('one_shot and no-run panes rounds have NO Run button; iterate rounds do', () => {
    expect(oaPanes()).not.toContain('id="run"');
    const noRun = sessionPage('s', { surface: 'panes', can_run_tests: false, statement: 'x' });
    expect(noRun).not.toContain('id="run"');
    const iterate = sessionPage('s', { surface: 'panes', can_run_tests: true, statement: 'x' });
    expect(iterate).toContain('id="run"');
  });

  it('the statement is escaped — LLM-generated text never becomes markup', () => {
    const html = sessionPage('s', {
      surface: 'panes',
      statement: 'Beware <script>alert(1)</script> & "quotes"',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('panes.js is a parseable classic script wired to the routes the server serves', () => {
    const js = clientScript('panes.js') ?? '';
    expect(() => new Function(js)).not.toThrow();
    for (const route of ['/api/files', '/api/file', '/api/panes-event', '/api/run']) {
      expect(js).toContain(route);
    }
    // The extension's 1s edit coalescing is the cadence the stuck detector
    // was tuned on — the panes emitter must match it.
    expect(js).toContain('1000');
  });

  it('the ended layout swallows the panes work area like it swallows the iframe', () => {
    expect(oaPanes()).toContain('body.ended main #panes { display: none; }');
  });
});

describe('solo rounds — conversation UI exists iff someone is listening (2026-08-15)', () => {
  const solo = (over = {}) => sessionPage('s', { interviewer: false, ...over });
  const js = clientScript() ?? '';

  it('no chat aside, no composer, no voice chrome, no voice script on either surface', () => {
    for (const html of [solo(), solo({ surface: 'panes', statement: 'x' })]) {
      expect(html).not.toContain('<aside>');
      expect(html).not.toContain('id="log"');
      expect(html).not.toContain('id="f"');
      expect(html).not.toContain('id="msg"');
      expect(html).not.toContain('id="voicechip"');
      expect(html).not.toContain('id="mute"');
      expect(html).not.toContain('id="intchip"');
      expect(html).not.toContain('startVoice');
    }
  });

  it('the notice line re-homes the etiquette, with the one-shot clause when it applies', () => {
    expect(solo()).toContain('id="notice"');
    expect(solo()).toContain('nobody replies');
    expect(solo({ one_shot: true })).toContain('runs ONCE, when you press Submit');
    expect(solo({ one_shot: true, can_run_tests: false })).toContain('Nothing runs this round');
    // Interviewer pages never render it — their aside carries the intro.
    expect(sessionPage('s')).not.toContain('id="notice"');
  });

  it('#feedback is a main child on EVERY variant — the graded card no longer lives in the aside', () => {
    for (const html of [solo(), solo({ surface: 'panes', statement: 'x' }), sessionPage('s')]) {
      expect(html).toContain('<div id="feedback"></div>');
      expect(html).toContain('body.ended #feedback');
      expect(html).toContain('body.ended aside { display: none; }');
    }
  });

  it('the client tolerates the missing aside and re-homes messages to the notice', () => {
    // say() must not throw at load, the composer binds conditionally, and
    // time-cap turns (the only solo-visible messages) reach notify().
    expect(js).toContain('if (!log) return null;');
    expect(js).toContain('function notify(');
    expect(js).toMatch(/if \(log\) say\('interviewer', m\.text\);\s*\n\s*else notify\(m\.text\);/);
    expect(js).toContain('const composerForm = document.getElementById');
    expect(js).toMatch(/if \(composerForm\) composerForm\.addEventListener/);
  });

  it('solo cards collapse unassessable rows into one honest line', () => {
    expect(js).toContain("card.interviewer === false");
    expect(js).toContain('Not observable this round (no interviewer)');
  });
});

describe('beta auth — session-origin token handoff (WU4)', () => {
  it('catches #token= before any request-firing script runs', () => {
    const page = sessionPage('sess-test');
    const catcher = page.indexOf("'#token='");
    const firstScriptSrc = page.indexOf('<script src=');
    expect(catcher).toBeGreaterThan(-1);
    expect(firstScriptSrc).toBeGreaterThan(-1);
    expect(catcher).toBeLessThan(firstScriptSrc);
    expect(page).toContain("document.cookie = 'ip_jwt='");
  });
});

describe('beta copy on the session card (WU9)', () => {
  it('the retention line rides below the patterns line in the card renderer', () => {
    const js = clientScript('session.js') ?? '';
    const patterns = js.indexOf('before patterns emerge');
    const note = js.indexOf('learning your patterns across rounds');
    expect(patterns).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(patterns); // below, never replacing
    // Trimmed 2026-08-15: no roadmap promises on the card.
    expect(js).not.toContain('Deeper memory is in development');
  });
});

describe('one-shot status copy (QA ISSUE-001)', () => {
  // Regression: ISSUE-001 — the header promised "waiting for first failing
  // test run" on rounds where no test run can occur (no Run button at all),
  // for the round's full duration.
  // Found by /qa on 2026-08-12
  // Report: .gstack/qa-reports/qa-report-localhost-2026-08-12.md
  it('marks one_shot rounds so the client can drop the impossible trigger copy', () => {
    const oneShot = sessionPage('s', { surface: 'panes', one_shot: true, statement: 'x' });
    expect(oneShot).toContain('data-one-shot="1"');
    // An iterate round keeps the trigger semantics — the attribute is the
    // ONLY thing separating them, so it must be absent there.
    const iterate = sessionPage('s', { surface: 'panes', one_shot: false, statement: 'x' });
    expect(iterate).not.toContain('data-one-shot');
  });

  it('the client branches the trigger phrase on that attribute', () => {
    const js = clientScript() ?? '';
    expect(js).toContain('suite runs once at submit');
    expect(js).toContain('oneShot');
    // The debugging-round phrase must survive for rounds that can arm it.
    expect(js).toContain('waiting for first failing test run');
  });
});

describe('panes flush completeness (QA ISSUE-002)', () => {
  const panes = clientScript('panes.js') ?? '';

  // Regression: ISSUE-002 — pending EDIT events were not flushed on submit,
  // so the last edits landed after session_end and were invisible to the
  // judge's trace snapshot ("made unseen edits").
  // Found by /qa on 2026-08-12
  // Report: .gstack/qa-reports/qa-report-localhost-2026-08-12.md
  it('flushes pending edit events, not just pending saves', () => {
    expect(panes).toContain('flushEdits');
    // flushSaves is the submit/run entry point; it must invoke the edit
    // flush, or the fix is unreachable from the only paths that call it.
    expect(panes).toMatch(/const flushSaves = \(\) => \{\s*\n\s*flushEdits\(\);/);
  });

  it('awaits the edit posts instead of firing them into the void', () => {
    // A fire-and-forget post still races /api/end. postEvent must return its
    // promise and the flush must track it.
    expect(panes).toMatch(/const postEvent = \([^)]*\) =>\s*\n?\s*fetch/);
    expect(panes).toContain("postEvent('edit', { path, changes: n }).finally");
    expect(panes).toContain('Promise.all([...inflight])');
  });

  it('is still a parseable classic script after the change', () => {
    expect(() => new Function(panes)).not.toThrow();
  });
});
