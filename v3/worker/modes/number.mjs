import {storage} from '../core/prefs.mjs';
import {log, query, match} from '../core/utils.mjs';
import {discard} from '../core/discard.mjs';
import {starters} from '../core/startup.mjs';
import {interrupts} from '../plugins/loader.mjs';

const number = {
  IGNORE: { // ignore defaults
    'idle': false,
    'battery': false,
    'online': false,
    'number': 0,
    'period': 0,
    'max.single.discard': Infinity,
    'ignore.meta.data': true
  }
};
const pluginFilters = {}; // this object adds custom filters to the number-based discarding

number.install = period => {
  // checking period is between 1 minute to 20 minutes
  period = Math.min(20 * 60, Math.max(60, period / 3));

  chrome.alarms.create('number.check', {
    when: Date.now() + period * 1000,
    periodInMinutes: period / 60
  });
};
number.remove = () => {
  chrome.alarms.clear('number.check');
};
// filterTabsFrom is a list of tab that if provided, discarding only happens on them
// ops is the preference object overwrite
number.check = async (filterTabsFrom, ops = {}) => {
  if (typeof interrupts !== 'undefined') {
    // wait for plug-ins to be ready
    await interrupts['before-action']();
  }
  else {
    console.warn('plugins module is not loaded');
  }

  log('number.check is called');
  const prefs = await storage({
    'mode': 'time-based',
    'number': 6,
    'max.single.discard': 50, // max number of tabs to discard
    'period': 10 * 60, // in seconds
    'audio': true, // audio = true => do not discard if audio is playing
    'paused': false, // paused = true => do not discard if there is a paused media player
    'pinned': false, // pinned = true => do not discard if tab is pinned
    'battery': false, // battery = true => only discard if power is disconnected
    'online': false, // online = true => do not discard if there is no INTERNET connection
    'form': true, // form = true => do not discard if form data is changed
    'whitelist': [],
    'notification.permission': false,
    'whitelist-url': [],
    'memory-enabled': false,
    'memory-value': 60,
    'idle': false,
    'idle-timeout': 5 * 60 // in seconds
  });
  Object.assign(prefs, await storage({
    'whitelist.session': []
  }, 'session'));

  Object.assign(prefs, ops);
  // only check if idle
  if (prefs.idle) {
    const state = await new Promise(resolve => chrome.idle.queryState(prefs['idle-timeout'], resolve));
    if (state !== chrome.idle.IdleState.IDLE) {
      return log('discarding is skipped', 'not in the idle state');
    }
  }
  // only check if on battery
  if (prefs.battery && navigator.getBattery) {
    const charging = await navigator.getBattery().then(b => b.charging === true || b.chargingTime !== Infinity);
    if (charging) {
      return log('discarding is skipped', 'Power is plugged-in');
    }
  }
  // only check if INTERNET is connected
  if (prefs.online && navigator.onLine === false) {
    return log('discarding is skipped', 'No INTERNET connection detected');
  }

  // get the total number of active tabs
  const options = {
    url: '*://*/*',
    discarded: false,
    active: false,
    autoDiscardable: true
  };
  if (prefs.pinned) {
    options.pinned = false;
  }
  if (prefs.audio) {
    options.audible = false;
  }
  let tbs = await query(options);
  const icon = (tb, title) => {
    chrome.action.setTitle({
      tabId: tb.id,
      title
    }, () => chrome.runtime.lastError);
    chrome.action.setIcon({
      tabId: tb.id,
      path: {
        '16': '/data/icons/disabled/16.png',
        '32': '/data/icons/disabled/32.png'
      }
    });
  };
  // remove tabs based on custom filters
  for (const {prepare, check} of Object.values(pluginFilters)) {
    await prepare();
    tbs = tbs.filter(check);
  }
  // remove tabs that match one of the matching lists
  let exceptionCount = 0;

  if (
    prefs['whitelist'].length ||
    prefs['whitelist.session'].length ||
    (prefs.mode === 'url-based' && prefs['whitelist-url'].length)
  ) {
    tbs = tbs.filter(tb => {
      try {
        const {hostname} = new URL(tb.url);

        const m = list => match(list, hostname, tb.url);
        // if we are on url-based mode, remove tabs that are not on the list (before fetching meta)
        if (prefs.mode === 'url-based' && m(prefs['whitelist-url']) !== true) {
          icon(tb, 'tab is in the whitelist');
          log('number.check', 'tab is ignored', 'url-based whitelist', tb.url);
          exceptionCount += 1;
          return false;
        }
        // is the tab in whitelist, remove it (before fetching meta)
        if (m(prefs['whitelist']) || m(prefs['whitelist.session'])) {
          icon(tb, 'tab is in either the session whitelist or permanent whitelist');
          log('number.check', 'tab is ignored', 'whitelist', tb.url);
          exceptionCount += 1;
          return false;
        }
        return true;
      }
      catch (e) {
        return false;
      }
    });
  }
  if (filterTabsFrom && filterTabsFrom.length) {
    const ids = filterTabsFrom.map(t => t.id);
    tbs = tbs.filter(tb => ids.includes(tb.id));
  }

  // do not discard if number of tabs is smaller than required
  if (tbs.length + exceptionCount <= prefs.number) {
    return log(
      'number.check', 'total number of active tabs', tbs.length,
      ' + ignored tabs', exceptionCount,
      'is equal or smaller than', prefs.number
    );
  }
  const now = Date.now();
  const map = new Map();
  const arr = [];
  for (const tb of tbs) {
    try {
      const ms = await chrome.scripting.executeScript({
        target: {
          tabId: tb.id,
          allFrames: true
        },
        files: ['/data/inject/meta.js']
      }).then(r => r.map(o => o.result), () => []);

      // remove protected tabs (e.g. addons.mozilla.org)
      if (ms.length === 0) {
        if (ops['ignore.meta.data'] === true && tb.url.startsWith('http') !== true) {
          log('discarding aborted', 'metadata fetch error', tb.url);
          icon(tb, 'metadata fetch error');
          exceptionCount += 1;
          continue;
        }
      }
      const meta = Object.assign({}, ...ms);
      log('number check', 'got meta data of tab');
      meta.forms = ms.some(o => o && o.forms);
      meta.audible = ms.some(o => o && o.audible);
      meta.paused = ms.some(o => o && o.paused);

      // is the tab using too much memory, discard instantly
      if (prefs['memory-enabled'] && meta.memory && meta.memory > prefs['memory-value'] * 1024 * 1024) {
        log('forced discarding', 'memory usage');
        discard(tb);
        continue;
      }
      // check tab's age
      if (now - meta.time < prefs.period * 1000) {
        log('discarding aborted', 'tab is not old');
        exceptionCount += 1;
        continue;
      }
      // is this tab loaded
      if (meta.ready !== true && ops['ignore.ready.state'] !== true) {
        log('discarding aborted', 'tab is not ready');
        exceptionCount += 1;
        continue;
      }
      // is tab playing audio
      if (prefs.audio && meta.audible) {
        log('discarding aborted', 'audio is playing');
        icon(tb, 'tab plays an audio');
        exceptionCount += 1;
        continue;
      }
      if (prefs.paused && meta.paused) {
        log('discarding aborted', 'player is paused');
        icon(tb, 'tab has a paused player');
        exceptionCount += 1;
        continue;
      }
      // is there an unsaved form
      if (prefs.form && meta.forms) {
        log('discarding aborted', 'active form');
        icon(tb, 'there is an active form on this tab');
        exceptionCount += 1;
        continue;
      }
      // is notification allowed
      if (prefs['notification.permission'] && meta.permission) {
        log('discarding aborted', 'tab has notification permission');
        icon(tb, 'tab has notification permission');
        exceptionCount += 1;
        continue;
      }
      map.set(tb, meta);
      arr.push(tb);
      if (arr.length > prefs['max.single.discard']) {
        log('number.check', 'breaking', 'max number of tabs reached');
        break;
      }
    }
    catch (e) {
      console.warn(e);
    }
  }
  // ready to discard
  log('number check', 'tabs that are ignored', exceptionCount);
  log('number check', 'possible tabs that could get discarded', arr.length);
  const tbds = arr
    .sort((a, b) => map.get(a).time - map.get(b).time)
    .slice(0, Math.min(arr.length + exceptionCount - prefs.number, prefs['max.single.discard']));

  log('number check', 'discarding', tbds.length);
  for (const tb of tbds) {
    discard(tb);
  }
};

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'number.check') {
    log('alarm fire', 'number.check', alarm.name);
    number.check();
  }
});

/* start */
{
  const check = () => storage({
    'mode': 'time-based',
    'period': 10 * 60, // in seconds
    'tmp_disable': 0
  }).then(ps => {
    if (
      ps.period &&
      (ps.mode === 'time-based' || ps.mode === 'url-based') &&
      ps['tmp_disable'] === 0
    ) {
      number.install(ps.period);
    }
    else {
      number.remove();
    }
  });
  starters.push(check);
  chrome.storage.onChanged.addListener(ps => {
    if (ps.period || ps.mode || ps['tmp_disable']) {
      check();
    }
  });
}

/* inject to existing tabs */
starters.push(() => chrome.app && query({
  url: '*://*/*',
  discarded: false
}).then(tbs => {
  const contentScripts = chrome.app.getDetails().content_scripts;
  for (const tab of tbs) {
    for (const cs of contentScripts) {
      chrome.scripting.executeScript({
        target: {
          tabId: tab.id,
          allFrames: cs.all_frames
        },
        files: cs.js
      }).catch(() => {});
    }
  }
}));

/* temporarily disable auto discarding */
{
  const exit = () => {
    chrome.action.setIcon({
      path: {
        '16': '/data/icons/tmp/' + '/16.png',
        '32': '/data/icons/tmp/' + '/32.png'
      }
    });
    chrome.action.setTitle({
      title: chrome.i18n.getMessage('bg_msg_2')
    });
  };
  chrome.storage.onChanged.addListener(ps => {
    if (ps['tmp_disable']) {
      if (ps['tmp_disable'].newValue !== 0) {
        chrome.alarms.create('tmp.disable', {
          when: Date.now() + ps['tmp_disable'].newValue * 60 * 60 * 1000
          // when: Date.now() + 120 * 1000
        });
        exit();
      }
      else {
        chrome.alarms.clear('tmp.disable');
        chrome.action.setIcon({
          path: {
            '16': '/data/icons/16.png',
            '32': '/data/icons/32.png'
          }
        });
        chrome.action.setTitle({
          title: chrome.runtime.getManifest().name
        });
      }
    }
  });
  starters.push(() => storage({
    'tmp_disable': 0
  }).then(ps => {
    if (ps['tmp_disable']) {
      // verify timer is installed
      chrome.alarms.get('tmp.disable', a => {
        if (a) {
          exit();
        }
        else {
          console.info('tmp timer is not present. Re-enabling the numbered module');
          chrome.storage.local.set({
            'tmp_disable': 0
          });
        }
      });
    }
  }));

  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'tmp.disable') {
      chrome.storage.local.set({
        'tmp_disable': 0
      });
    }
  });
}

export {pluginFilters, number};
