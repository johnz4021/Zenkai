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
    // The shared chrome survives the fork: Submit flow, clock, chat aside.
    expect(html).toContain('>Submit</button>');
    expect(html).toContain('data-limit="6300000"');
    expect(html).toContain('id="log"');
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
