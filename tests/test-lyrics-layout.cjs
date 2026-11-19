'use strict';

// Real renderer/CSS/fonts, synthetic lyrics, no app entry or persistent profile.
// Run with Node; the launcher uses the project's installed Electron.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const repo = path.resolve(__dirname, '..');

async function checkRenderer(moduleURL, wrappedFixture, pointerFixture) {
  const { LyricsView, parseLyrics } = await import(moduleURL);
  await document.fonts.load('700 40px "SF Pro Display"');
  await document.fonts.ready;
  const view = new LyricsView(document.querySelector('.lyrics'));
  const checks = [];
  const check = (name, ok, details) => checks.push({ name, ok: Boolean(ok), details });
  const fillWords = [
    { time: 0, end: 2, text: 'Held ' },
    { time: 2, end: 2.1, text: 'fast ' },
    { time: 2.1, end: 2.3, text: 'ending' }
  ];
  const fillGeometry = { prefix: [0, 100, 200], widths: [100, 100, 100], total: 300, fadeWidth: 30 };
  const fillAt = position => view.lineFillFrontierFor(0, fillGeometry, fillWords, position);
  const heldSpeed = (fillAt(1.6) - fillAt(1.5)) / 0.1;
  const fastSpeed = (fillAt(2.06) - fillAt(2.05)) / 0.01;
  check('tight word timings accelerate the moving fill', fastSpeed > heldSpeed * 10);
  check('word retargets preserve the displayed fill position',
    Math.abs(fillAt(2.000001) - fillAt(1.999999)) < 0.01 &&
    Math.abs(fillAt(2.100001) - fillAt(2.099999)) < 0.01);
  const fillSamples = Array.from({ length: 301 }, (_, i) => fillAt(i / 100));
  check('accelerated fill never rewinds or overshoots', fillSamples.every((value, i) =>
    value >= 0 && value <= 330 && (i === 0 || value >= fillSamples[i - 1])));
  check('final soft edge finishes its sweep after the vocal', fillAt(2.3) < 330 && fillAt(3) === 330);
  const seekFill = fillAt(2.05);
  fillAt(3);
  fillAt(0.2);
  check('seeking and skipped frames do not change fill pacing', fillAt(2.05) === seekFill);
  view.reduceMotion = { matches: true };
  check('reduced motion retains direct word-timed fill',
    fillAt(2.05) === view.computeLineFillFrontier(fillGeometry, fillWords, 2.05));
  view.reduceMotion = { matches: false };
  const sharedTiming = [{ time: 0, end: 1, text: 'to' }, { time: 0, end: 1, text: 'gether' }];
  const sharedGeometry = { prefix: [0, 40], widths: [40, 60], total: 100, fadeWidth: 30 };
  const sharedFill = view.lineFillFrontierFor(0, sharedGeometry, sharedTiming, 0.5);
  check('words sharing a clock sweep together', Math.abs(sharedFill - 50) < 0.001);
  const qrc = parseLyrics('[offset:100]\n[1000,3000]Hello (1000,500)world(2200,800)\n[5000,0]Next(5000,0)');
  check('QRC keeps absolute word times, ends and gaps',
    qrc[0].time === 1.1 && qrc[0].end === 4.1 && qrc[0].text === 'Hello world' &&
    qrc[0].words[0].end === 1.6 && Math.abs(qrc[0].words[1].time - 2.3) < 0.0001);
  check('QRC zero duration has a usable word end', qrc[1].words[0].end > qrc[1].words[0].time);
  const xmlQrc = parseLyrics('<QrcInfos><LyricInfo><Lyric_1 LyricContent="[1000,1000]You &amp; (1000,500)I(1500,500)\n[3000,1000]Next(3000,1000)"/></LyricInfo></QrcInfos>', 'lyrics.xml');
  check('QRC XML decodes entities and preserves literal newlines', xmlQrc.length === 2 && xmlQrc[0].text === 'You & I');
  const providerQrc = parseLyrics('<?xml version="1.0" encoding="utf-8"?>\n' +
    '<QrcInfos>\n<QrcHeadInfo SaveTime="1" Version="100"/>\n<LyricInfo LyricCount="1">\n' +
    '<Lyric_1 LyricType="1" LyricContent="[ti:Armed & Dangerous]\n' +
    '[offset:0]\n[0,1000]Say "(0,500)hi(500,500)"\n"/>\n' +
    '</LyricInfo>\n</QrcInfos>');
  check('provider QRC XML tolerates raw ampersands and quotes',
    providerQrc.length === 1 && providerQrc[0].text === 'Say "hi"');
  check('malformed QRC XML is rejected', parseLyrics('<QrcInfos><bad>', 'lyrics.qrc').length === 0);
  const elrc = parseLyrics('[00:01.00]<00:01.00>Hello <00:02.20>world<00:03.00>\n[00:04]Next\n[offset:100]', 'lyrics.elrc');
  check('ELRC keeps word boundaries and explicit end markers', elrc[0].text === 'Hello world' &&
    elrc[0].time === 1.1 && Math.abs(elrc[0].words[0].end - 2.3) < 0.0001 && elrc[0].words[1].end === 3.1);
  const repeated = parseLyrics('[00:01][00:05]<00:01>Hello <00:02>world<00:03>');
  check('ELRC repeated lines shift word windows with each line', repeated[1].words[0].time === 5 && repeated[1].words[1].end === 7);
  check('ordinary LRC remains line synced', !parseLyrics('[00:01]Hello')[0].words);
  const max = values => Math.max(0, ...values);
  const range = values => Math.max(...values) - Math.min(...values);
  const frame = () => new Promise(requestAnimationFrame);
  const snapshot = () => view.lineStates.map(state => {
    const main = state.element.querySelector('.lyrics-main-text').getBoundingClientRect();
    return { top: main.top, center: main.top + main.height / 2,
      spring: state.y.value, velocity: state.y.velocity,
      target: state.y.queuedTarget ?? state.y.target };
  });
  const lines = [
    { time: 0, end: 3, text: 'Opening lead' },
    { time: 3, end: 6, text: 'Current parent', backgroundText: 'Backing answer' },
    { time: 6, end: 9, text: 'Following lead' },
    { time: 9, end: 12, text: 'A longer current parent wraps over several lines in the lyric column',
      backgroundBefore: true,
      backgroundText: 'These invented backing voices have a longer answer that wraps over several lines' },
    { time: 12, end: 15, text: 'Final lead' }
  ];
  const targets = view.updateTargets;
  let largestImmediateJump = 0;
  let largestVelocityChange = 0;
  view.updateTargets = function (...args) {
    const before = snapshot();
    const result = targets.apply(this, args);
    const after = snapshot();
    largestImmediateJump = Math.max(largestImmediateJump,
      max(after.map((row, i) => Math.abs(row.top - before[i].top))));
    largestVelocityChange = Math.max(largestVelocityChange,
      max(after.map((row, i) => Math.abs(row.velocity - before[i].velocity))));
    return result;
  };
  // The origin relative to a row's own positional spring must stay constant
  // during a reveal. A changing origin is a SECOND positional animation,
  // even when it eventually settles at the correct place.
  const sample = async (label, position, drive = true, milliseconds = 1250) => {
    const records = [];
    let observerJump = 0;
    const until = performance.now() + milliseconds;
    do {
      await frame();
      const previous = records.at(-1);
      if (previous) observerJump = Math.max(observerJump,
        max(snapshot().map((row, i) => Math.abs(row.top - previous[i].top))));
      if (drive) view.update(position, 15, false);
      else view.stepMotion();
      records.push(snapshot());
    } while (performance.now() < until);
    const originDrift = max(view.lineStates.map((_, i) =>
      range(records.map(rows => rows[i].top - rows[i].spring))));
    const targetDrift = max(view.lineStates.map((_, i) =>
      range(records.map(rows => rows[i].target))));
    check(`${label}: each row follows only its own position spring`, originDrift < 0.05,
      { originDrift, frames: records.length });
    check(`${label}: reveal does not chase a moving scroll target`, targetDrift < 0.05, { targetDrift });
    check(`${label}: layout observers do not add another movement`, observerJump < 0.05, { observerJump });
    const anchor = records.at(-1)[view.anchorIndex];
    const expected = view.track.getBoundingClientRect().top + innerHeight * 0.3815;
    check(`${label}: settled lead anchor is unchanged`, Math.abs(anchor.center - expected) < 0.5,
      { actual: anchor.center, expected });
    if (drive) check(`${label}: only current backing is expanded`, view.backgroundStates.every((state, i) => {
      if (!state) return true;
      const active = i === view.anchorIndex && view.activeIndices.includes(i);
      return state.isActive === active &&
        Math.abs(state.slot.getBoundingClientRect().height - (active ? state.height : 0)) < 0.15;
    }));
    return records;
  };

  try {
    view.setLyrics(lines, 0.5, 15, false);
    for (const [label, position] of [
      ['bottom entrance', 3.1], ['bottom exit', 6.1],
      ['wrapped above entrance', 9.1], ['wrapped above exit', 12.1],
      ['backward seek', 3.1]
    ]) {
      view.update(position, 15, false);
      await sample(label, position);
    }
    check('retargeting never jumps rendered positions', largestImmediateJump < 0.05,
      { largestImmediateJump });

    // Isolate bottom collapse from an ordinary change of the selected lead.
    // The parent must stay put; lower rows must close the gap continuously.
    // Settle first: the previous seek's slowSpring is still finishing, and its
    // residual motion would otherwise count as collapse drift on the parent.
    const settleUntil = performance.now() + 2000;
    while (performance.now() < settleUntil && view.lineStates.some(state =>
      Math.abs(state.y.velocity) > 0.001 || Math.abs(state.y.target - state.y.value) > 0.01)) {
      await frame();
      view.stepMotion();
    }
    const before = snapshot();
    const height = view.backgroundStates[1].slot.getBoundingClientRect().height;
    view.syncBackgroundTargets([]);
    view.updateTargets(1, { stagger: false });
    const closing = await sample('layout-only collapse', 3.1, false);
    const parentDrift = max(closing.map(rows => Math.abs(rows[1].top - before[1].top)));
    check('collapse leaves its parent stationary', parentDrift < 0.05, { parentDrift });
    const final = closing.at(-1);
    check('lower rows reclaim exactly the closed gap', final.slice(2).every((row, i) =>
      Math.abs(row.top - before[i + 2].top + height) < 0.5), { height });
    check('collapse has intermediate positions, not a snap', closing.filter(rows =>
      rows[2].top < before[2].top - 1 && rows[2].top > final[2].top + 1).length >= 6);
    check('inactive background occupies zero space', view.backgroundStates[1].slot.getBoundingClientRect().height === 0);

    // Natural playback must keep the same one-spring contract with the real
    // 50ms row cascade, not only the no-stagger transport/seek path above.
    for (const [label, startPosition, owner] of [['playing entrance', 2.8, 1], ['playing exit', 5.8, 2]]) {
      view.setLyrics(lines, startPosition, 15, true);
      const began = await frame();
      const records = [];
      let delayedFrames = 0;
      let delayedMovement = 0;
      let now = began;
      do {
        const before = snapshot();
        view.update(startPosition + (now - began) / 1000, 15, true);
        const after = snapshot();
        if (view.anchorIndex === owner) {
          records.push(after);
          view.lineStates.forEach((state, i) => {
            if (state.y.queuedDelay > 0 && Math.abs(state.y.velocity) < 1e-7) {
              delayedFrames += 1;
              delayedMovement = Math.max(delayedMovement, Math.abs(after[i].top - before[i].top));
            }
          });
        }
        now = await frame();
      } while (now - began < 1500);
      const drift = max(view.lineStates.map((_, i) => range(records.map(rows => rows[i].top - rows[i].spring))));
      check(`${label}: real handoff uses a single positional spring`, drift < 0.05, { drift });
      check(`${label}: reveal cannot bypass the row stagger`, delayedFrames > 0 && delayedMovement < 0.05,
        { delayedFrames, delayedMovement });
    }

    const wrapped = lines.map(line => ({ ...line }));
    wrapped[1].backgroundText = lines[3].backgroundText;
    view.setLyrics(wrapped, 0.5, 15, false);
    view.update(3.1, 15, false);
    await sample('wrapped bottom entrance', 3.1);
    view.update(6.1, 15, false);
    await sample('wrapped bottom exit', 6.1);
    view.update(9.1, 15, false);
    // Reverse direction while the springs still have velocity.
    for (let i = 0; i < 6; i += 1) { await frame(); view.update(9.1, 15, false); }
    check('reversal fixture is actually moving', view.lineStates.some(state => Math.abs(state.y.velocity) > 1));
    view.update(3.1, 15, false);
    await sample('mid-flight reversal', 3.1);
    check('layout retargets preserve scroll velocity', largestVelocityChange < 1e-7, { largestVelocityChange });
    check('all handoffs preserve immediate DOM position', largestImmediateJump < 0.05, { largestImmediateJump });

    const overlap = [
      { time: 0, end: 8, text: 'Earlier lead', words: [{ time: 0, end: 2, text: 'Earlier lead' }],
        backgroundText: 'Long backing tail' },
      { time: 3, end: 9, text: 'Next lead', backgroundText: 'Current backing' }
    ];
    view.setLyrics(overlap, 3.5, 15, false);
    await sample('paused initial overlap', 3.5);
    check('audio overlap is preserved without opening the old background',
      view.activeIndices.join(',') === '0,1' && view.anchorIndex === 1 &&
      !view.backgroundStates[0].isActive && view.backgroundStates[0].slot.getBoundingClientRect().height === 0);
    check('current backing remains visible while paused', view.backgroundStates[1].isActive &&
      Math.abs(Number(getComputedStyle(view.backgroundStates[1].element).opacity) *
        Number(getComputedStyle(view.lineElements[1]).opacity) - 0.3) < 0.001);
    const pairedVocals = [
      { time: 0, end: 4, text: 'First voice', words: [{ time: 0, end: 4, text: 'First voice' }] },
      { time: 2, end: 7, text: 'Second voice', words: [{ time: 2, end: 7, text: 'Second voice' }] },
      { time: 8, end: 11, text: 'Following phrase', words: [{ time: 8, end: 11, text: 'Following phrase' }] }
    ];
    view.setLyrics(pairedVocals, 1.9, 15, true);
    view.update(2.05, 15, true);
    check('a newly arriving overlapping voice keeps the normal cascade',
      view.activeIndices.join(',') === '0,1' && view.anchorIndex === 0 &&
      view.lineStates[1].y.queuedDelay > 0);
    view.setLyrics(pairedVocals, 3.9, 15, true);
    const overlapTargets = view.lineStates.map(state => state.y.target);
    view.update(4.01, 15, true);
    check('an already-singing partner takes the scroll without stagger when the first voice ends',
      view.activeIndices.join(',') === '1' && view.anchorIndex === 1 &&
      view.lineStates.every(state => state.y.queuedDelay === 0 && state.y.queuedTarget === null) &&
      view.lineStates.some((state, index) => state.y.target !== overlapTargets[index]) &&
      pairedVocals[1].end - 4.01 > 0.9);
    const nextPhraseStart = view.effectiveStarts[2];
    view.setLyrics(pairedVocals, nextPhraseStart - 0.05, 15, true);
    view.update(nextPhraseStart + 0.01, 15, true);
    check('the following new phrase still uses stagger after an overlap handoff',
      view.anchorIndex === 2 && view.lineStates[2].y.queuedDelay > 0);
    const crowdedVocals = Array.from({ length: 6 }, (_, index) => ({
      time: index * 0.5, end: 8 + index * 0.5, text: 'Overlapping voice ' + index,
      words: [{ time: index * 0.5, end: 8 + index * 0.5, text: 'Overlapping voice ' + index }]
    }));
    view.setLyrics(crowdedVocals, 2.2, 15, true);
    check('initial overlapping vocals select only the newest pair',
      view.activeIndices.join(',') === '3,4' && view.anchorIndex === 3 &&
      view.lineElements.filter(row => row.classList.contains('is-active')).length === 2);
    view.update(2.7, 15, true);
    check('long overlapping ends cannot accumulate active rows during playback',
      view.activeIndices.join(',') === '4,5' && view.anchorIndex === 4 &&
      view.lineElements.filter(row => row.classList.contains('is-active')).length === 2 &&
      view.lineStates.slice(0, 4).every((_, index) => view.targetOpacityForLine(index) === 0.175 &&
        view.targetBlurForLine(index) > 0));
    view.update(0.7, 15, true);
    check('seeking rebuilds the overlapping pair without retaining later voices',
      view.activeIndices.join(',') === '0,1' && view.anchorIndex === 0);
    view.setLyrics(overlap, 3.5, 15, false);
    view.reduceMotion = { matches: true };
    view.update(0.5, 15, false);
    check('reduced motion applies visibility and layout in one update',
      view.backgroundStates[0].isActive && view.backgroundStates[1].slot.getBoundingClientRect().height === 0 &&
      view.lineStates.every(state => state.y.value === state.y.target));
    check('reduced motion moves every row to the same destination without losing delayed targets',
      view.lineStates.every(state => Math.abs(state.y.value - view.lineStates[0].y.value) < 0.001 && state.y.queuedTarget === null));
    view.setLyrics(lines, 2.6, 15, true);
    view.update(3.1, 15, true);
    check('natural handoff under reduced motion keeps all rows aligned',
      view.anchorIndex === 1 && view.lineStates.every(state =>
        Math.abs(state.y.value - view.lineStates[0].y.value) < 0.001 && state.y.queuedTarget === null));
    view.reduceMotion = { matches: false };
    view.setLyrics(lines, 2.6, 15, true);
    view.update(3.1, 15, true);
    const destination = view.lineStates[0].y.target;
    check('motion preference change fixture has a pending stagger', view.lineStates.some(state => state.y.queuedTarget !== null));
    view.reduceMotion = { matches: true };
    view.stepMotion();
    check('enabling reduced motion during a stagger preserves every destination',
      view.lineStates.every(state => Math.abs(state.y.value - destination) < 0.001 && state.y.queuedTarget === null));
    view.reduceMotion = { matches: false };
    view.setLyrics(lines, 2.6, 15, true);
    check('completed-line fading defaults to off', !view.fadeCompleted && !view.element.classList.contains('is-fade-completed'));
    view.setFadeCompleted(true);
    const rowHeight = view.lineElements[0].offsetHeight;
    await new Promise(resolve => setTimeout(resolve, 280));
    view.update(3.1, 15, true);
    const fadeSamples = [];
    const fadePlan = view.completedFades.get(0);
    const fadeStart = performance.now();
    let opacityError = 0;
    while (view.completedFades.has(0) && performance.now() - fadeStart < 1500) {
      await frame();
      view.update(3.1, 15, true);
      const spring = view.lineStates[0].y;
      const progress = Math.max(0, Math.min(1, (spring.value - fadePlan.startY) / (fadePlan.targetY - fadePlan.startY)));
      const opacity = Number(getComputedStyle(view.lineElements[0]).opacity);
      opacityError = Math.max(opacityError, Math.abs(opacity - fadePlan.from * (1 - progress)));
      fadeSamples.push({ y: spring.value, opacity });
    }
    check('completed opacity is derived from the moving row spring on every frame',
      opacityError < 0.00011 && fadeSamples.length > 5 && fadeSamples.some(sample => sample.opacity > 0.2 && sample.opacity < 0.8),
      { opacityError, frames: fadeSamples.length });
    check('completed line disappears without collapsing its layout',
      Number(getComputedStyle(view.lineElements[0]).opacity) === 0 && view.lineElements[0].offsetHeight === rowHeight);
    check('current and upcoming lines remain visible',
      Number(getComputedStyle(view.lineElements[1]).opacity) > 0 && Number(getComputedStyle(view.lineElements[2]).opacity) > 0);
    view.element.classList.add('is-scrolling');
    await new Promise(resolve => setTimeout(resolve, 750));
    check('manual scrolling reveals completed lines for seeking', Number(getComputedStyle(view.lineElements[0]).opacity) > 0);
    view.element.classList.remove('is-scrolling');
    view.update(0.5, 15, false);
    check('seeking backward clears completed status', !view.lineElements[0].classList.contains('is-completed'));
    view.setLyrics(overlap, 3.5, 15, true);
    check('completed-line fade preserves overlapping vocals and backing tails', !view.lineElements[0].classList.contains('is-completed'));
    view.update(8.5, 15, true);
    check('overlapping line fades only after its sung end', view.lineElements[0].classList.contains('is-completed'));
    view.setFadeCompleted(false);
    check('disabling completed-line fade clears every hidden line', view.completedIndices.size === 0 && !view.track.querySelector('.is-completed'));
    view.setLyrics(lines, 2.6, 15, true);
    view.setFadeCompleted(true);
    view.update(3.1, 15, true);
    // A delayed frame advances the row only by maxFrameDelta. Opacity must
    // advance by that same spring movement, not by a separate wall clock.
    view.stepMotion(view.lastMotionTime + 1000);
    const delayedSpring = view.lineStates[0].y;
    check('a delayed frame cannot finish opacity before the row spring moves',
      Math.abs(delayedSpring.value - delayedSpring.target) > 0.1 &&
      Number(getComputedStyle(view.lineElements[0]).opacity) > 0);
    view.lastMotionTime = performance.now();
    view.setFadeCompleted(false);
    view.setFadeCompleted(true);
    view.setLyrics([
      { time: 0, end: 3, text: 'Finished phrase', words: [{ time: 0, end: 3, text: 'Finished phrase' }] },
      { time: 3.5, end: 7, text: 'Next phrase' }
    ], 2, 10, true);
    const outgoingGeometry = view.ensureLineFillGeometry(0);
    const outgoingWords = view.lines[0].words;
    const outgoingFill = position => view.lineFillFrontierFor(0, outgoingGeometry, outgoingWords, position);
    const finishWindow = view.fillAccelerationWindowFor(0, outgoingWords);
    check('accelerated row handoff shares the fill completion time',
      view.effectiveStarts[1] === finishWindow.end && view.focusEnds[0] === finishWindow.end);
    check('fill preparation includes the gap-dependent spring settling time',
      Math.abs(finishWindow.start - 2.313333978658051) < 0.000001 &&
      Math.abs(finishWindow.end - 2.563333978658051) < 0.000001);
    const finishFrom = outgoingFill(finishWindow.start);
    const finishFull = outgoingGeometry.total + outgoingGeometry.fadeWidth;
    check('handoff acceleration sweeps the remaining fill linearly over 250ms',
      Math.abs(outgoingFill(finishWindow.start + 0.125) - (finishFrom + finishFull) / 2) < 0.001 &&
      outgoingFill(finishWindow.end) === finishFull);
    check('fill acceleration starts continuously from the preceding word sweep',
      Math.abs(outgoingFill(finishWindow.start - 0.000001) - finishFrom) < 0.001);
    view.update(finishWindow.end - 0.001, 10, true);
    check('outgoing line stays selected through the accelerating sweep', view.anchorIndex === 0);
    const beforeFillHandoff = view.lineStates[1].y.target;
    view.update(finishWindow.end, 10, true);
    check('next line is selected at fill completion without another timer', view.anchorIndex === 1);
    check('fill completion queues the next row with its existing stagger',
      view.lineStates[1].y.queuedTarget !== null && view.lineStates[1].y.queuedDelay > 0 &&
      Math.abs(view.lineStates[1].y.queuedTarget - beforeFillHandoff) > 0.01);
    view.update(2.95, 10, true);
    check('accelerated fill completes before the outgoing row dims',
      view.anchorIndex === 1 && outgoingFill(2.95) === finishFull);
    const acceleratedHandoff = view.effectiveStarts[1];
    view.setAccelerateFill(false);
    check('disabling acceleration restores the 0.5 second row head start',
      Math.abs(view.effectiveStarts[1] - 2.5) < 0.00001 &&
      view.lineFillFrontierFor(0, outgoingGeometry, view.lines[0].words, 2.95) ===
        view.computeLineFillFrontier(outgoingGeometry, view.lines[0].words, 2.95));
    view.setAccelerateFill(true);
    check('re-enabling acceleration restores the coupled row handoff', view.effectiveStarts[1] === acceleratedHandoff);
    view.update(3.01, 10, true);
    check('later word times cannot restart a completed handoff sweep', outgoingFill(3.01) === finishFull);
    view.update(4, 10, true);
    check('completed-line fade waits for the fill tail',
      view.anchorIndex === 1 && view.lineElements[0].classList.contains('is-completed'));
    view.setFadeCompleted(false);
    view.setLyrics([
      { time: 0, end: 3, text: 'Held fast ending', words: fillWords.map((word, i) => ({
        ...word, time: [0, 2.8, 2.9][i], end: [2.8, 2.9, 3][i]
      })) },
      { time: 3, end: 6, text: 'Back to back' },
      { time: 6, end: 9, text: 'Following row' }
    ], 2.1, 9, true);
    const rapidGeometry = view.ensureLineFillGeometry(0);
    const rapidWords = view.lines[0].words;
    const rapidWindow = view.fillAccelerationWindowFor(0, rapidWords);
    check('back-to-back fill starts 750ms before the outgoing vocal ends',
      rapidWindow.start === 2.25 && rapidWindow.end === 2.5);
    const accelerated = view.lineFillFrontierFor(0, rapidGeometry, rapidWords, 2.4);
    view.setAccelerateFill(false);
    const unaccelerated = view.lineFillFrontierFor(0, rapidGeometry, rapidWords, 2.4);
    check('back-to-back lines accelerate across upcoming words before the handoff',
      accelerated > unaccelerated + rapidGeometry.fadeWidth &&
      view.effectiveStarts[1] === 3);
    view.setAccelerateFill(true);
    view.update(2.49, 9, true);
    check('back-to-back line keeps focus until its accelerated fill completes', view.anchorIndex === 0);
    view.update(2.5, 9, true);
    check('back-to-back line hands off at fill completion with the original row cascade',
      view.anchorIndex === 1 && view.lineStates[1].y.queuedTarget !== null &&
      view.lineStates[1].y.queuedDelay > 0 &&
      Math.abs(view.lineStates[2].y.queuedDelay - view.lineStates[1].y.queuedDelay - 0.05) < 0.000001);
    // These timing samples cover a rapid phrase, a short inter-line gap and
    // a longer gap. Their expected windows include both scheduling gates.
    for (const [time, end, next, expectedStart] of [
      [25.031, 25.922, 26.127, 25.191635489562103],
      [29.426, 30.936, 31.084, 30.186],
      [31.084, 32.63, 32.974, 31.924786979542702]
    ]) {
      const fixture = {
        lines: [{ time, end }, { time: next }],
        sungEnds: [end]
      };
      const window = view.fillAccelerationWindowFor.call(fixture, 0, [{ time, end }]);
      check(`rapid phrase at ${time}s uses the verified preparation window`,
        Math.abs(window.start - expectedStart) < 0.000001 &&
        Math.abs(window.end - expectedStart - 0.25) < 0.000001);
    }
    view.setLyrics([
      { time: 0, end: 4, text: 'Overlapping vocal', words: [{ time: 0, end: 4, text: 'Overlapping vocal' }] },
      { time: 3, end: 6, text: 'Another singer' }
    ], 2.8, 6, true);
    const overlapGeometry = view.ensureLineFillGeometry(0);
    const overlapFill = view.lineFillFrontierFor(0, overlapGeometry, view.lines[0].words, 3);
    check('handoff acceleration preserves overlapping vocal timing',
      overlapFill === view.wordFillFrontierFor(overlapGeometry, view.lines[0].words, 3) &&
      overlapFill < overlapGeometry.total + overlapGeometry.fadeWidth);
    view.setLyrics([
      { time: 0, end: 4, text: 'upper lower tail', words: wrappedFixture.words },
      { time: 4, end: 7, text: 'Next phrase' }
    ], 1, 8, true);
    for (const sample of wrappedFixture.samples) {
      const frontiers = view.lineFillFrontiersFor(0, wrappedFixture.geometry, wrappedFixture.words, sample.time);
      check(`wrapped fill at ${sample.time}s matches the extracted mask loop`,
        frontiers.every((frontier, i) => Math.abs(frontier - sample.frontiers[i]) < .0002),
        { frontiers, expected: sample.frontiers });
    }
    const rewindFrontiers = view.lineFillFrontiersFor(0, wrappedFixture.geometry, wrappedFixture.words, 3.3);
    check('seeking back into a wrapped sweep keeps each mask on its own trajectory',
      rewindFrontiers.every((frontier, i) => Math.abs(frontier - wrappedFixture.samples[1].frontiers[i]) < .0002));
    const wrappedFillWords = [
      { time: 3.6, end: 3.8, text: 'Silver ' },
      { time: 3.8, end: 4, text: 'go' }
    ];
    view.setLyrics([
      { time: 0, end: 4, text: 'Silver go', words: wrappedFillWords,
        backgroundText: 'Silver go', backgroundWords: wrappedFillWords },
      { time: 4, end: 7, text: 'Next phrase' }
    ], 1, 8, true);
    const wrappedFillMain = view.lineElements[0].querySelector('.lyrics-main-text');
    wrappedFillMain.style.width = '130px';
    view.lineElements[0].style.fontSize = '40px';
    const wrappedFillBackground = view.backgroundStates[0].element;
    wrappedFillBackground.style.fontSize = '40px';
    view.backgroundStates[0].inner.style.fontSize = '40px';
    view.backgroundStates[0].inner.style.width = '130px';
    view.refreshMetrics();
    const wrappedFillGeometry = view.ensureLineFillGeometry(0);
    const wrappedFillWindow = view.fillAccelerationWindowFor(0, wrappedFillWords);
    const wrappedFillMiddle = wrappedFillWindow.start + 0.15;
    const wrappedFrontiers = view.lineFillFrontiersFor(0, wrappedFillGeometry, wrappedFillWords, wrappedFillMiddle);
    check('wrapped lyric has independent masks for two unequal visual rows',
      wrappedFillGeometry.runs.length === 2 &&
      Math.abs(wrappedFillGeometry.runs[0].total - wrappedFillGeometry.runs[1].total) > 20);
    check('both unsung wrapped rows start accelerating together before the first row finishes',
      wrappedFrontiers.every((frontier, i) => frontier > 0 &&
        frontier < wrappedFillGeometry.runs[i].total + wrappedFillGeometry.fadeWidth) &&
      wrappedFrontiers.every((frontier, i) =>
        Math.abs(frontier / (wrappedFillGeometry.runs[i].total + wrappedFillGeometry.fadeWidth) - 0.6) < 0.00001));
    view.updateLineFill(0, wrappedFillMiddle);
    check('lower wrapped row paints its fill while the upper row is still filling',
      view.wordElements[0].every((word, i) => word.__fill > -wrappedFillGeometry.fadeWidth &&
        word.__fill < wrappedFillGeometry.widths[i]));
    const wrappedFull = view.lineFillFrontiersFor(0, wrappedFillGeometry, wrappedFillWords, wrappedFillWindow.end);
    check('all wrapped masks finish on the same handoff frame', wrappedFull.every((frontier, i) =>
      Math.abs(frontier - wrappedFillGeometry.runs[i].total - wrappedFillGeometry.fadeWidth) < 0.00001));
    const backingGeometry = view.ensureBackgroundFillGeometry(0);
    const backingFrontiers = view.lineFillFrontiersFor(0, backingGeometry, view.lines[0].backgroundWords, wrappedFillMiddle);
    view.updateBackgroundLineFill(0, wrappedFillMiddle);
    check('wrapped backing words also sweep their rows concurrently', backingGeometry.runs.length === 2 &&
      backingFrontiers.every((frontier, i) => frontier > 0 && frontier < backingGeometry.runs[i].total + backingGeometry.fadeWidth),
      { runs: backingGeometry.runs, frontiers: backingFrontiers,
        font: getComputedStyle(view.backgroundWordElements[0][0]).fontSize });
    const partialWords = [{ time: 0, end: 3, text: 'Silver ' }, { time: 3, end: 4, text: 'go' }];
    // Reuse the actual measured wrap with a partially sung lower row, rather
    // than testing only two completely unsung masks at the handoff.
    const partialGeometry = { ...wrappedFillGeometry, runGeometries: undefined, fillSegments: undefined };
    const partialWindow = view.fillAccelerationWindowFor(0, partialWords);
    const beforePartial = view.lineFillFrontiersFor(0, partialGeometry, partialWords, partialWindow.start - .000001);
    const atPartial = view.lineFillFrontiersFor(0, partialGeometry, partialWords, partialWindow.start);
    check('upper row retains its feather while the lower row is already singing',
      atPartial[0] < partialGeometry.runs[0].total + partialGeometry.fadeWidth && atPartial[1] > 0);
    check('partially sung row masks enter acceleration without a jump',
      atPartial.every((frontier, i) => Math.abs(frontier - beforePartial[i]) < .001));
    const partialMiddle = view.lineFillFrontiersFor(0, partialGeometry, partialWords, partialWindow.start + .125);
    check('each partly filled mask sweeps from its own displayed edge',
      partialMiddle.every((frontier, i) => Math.abs(frontier -
        (atPartial[i] + partialGeometry.runs[i].total + partialGeometry.fadeWidth) / 2) < .00001));
    wrappedFillMain.style.width = '400px';
    view.refreshMetrics();
    check('reflow rebuilds visual mask rows instead of retaining old wrap coordinates',
      view.ensureLineFillGeometry(0).runs.length === 1);
    for (const text of ['abcdefghijklmnopqrstuvwxyz', '你好世界你好世界你好世界']) {
      const words = [{ time: 3.6, end: 4, text }];
      view.setLyrics([{ time: 0, end: 4, text, words }, { time: 4, end: 7, text: 'Next' }], 1, 8, true);
      view.lineElements[0].querySelector('.lyrics-main-text').style.width = '130px';
      view.lineElements[0].style.fontSize = '40px';
      view.refreshMetrics();
      const geo = view.ensureLineFillGeometry(0);
      const fillWindow = view.fillAccelerationWindowFor(0, words);
      view.updateLineFill(0, fillWindow.start + 0.15);
      const firstGlyphs = new Map();
      geo.charRuns[0].forEach((run, i) => {
        if (!firstGlyphs.has(run.runIndex)) firstGlyphs.set(run.runIndex, view.wordMotions[0][0].chars[i]);
      });
      check(`a single wrapped ${/^[a-z]/.test(text) ? 'long word' : 'CJK word'} starts every row mask together`,
        geo.runs.length > 1 && firstGlyphs.size === geo.runs.length &&
        [...firstGlyphs.values()].every(char => char.lastFill > -geo.fadeWidth));
    }
    const ttml = `<tt xmlns="http://www.w3.org/ns/ttml"
      xmlns:amll="http://apple.com/itunes/amll"><head><metadata>
      <iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><songwriters>
      <songwriter>Matthew Martin</songwriter><songwriter>Second Writer</songwriter>
      </songwriters></iTunesMetadata>
      <amll:meta key="songwriter" value="Matthew Martin"/>
      <amll:meta key="ttmlAuthor" value="Community Creator"/>
      </metadata></head><body><div><p begin="0s" end="5s">A final lyric line</p></div></body></tt>`;
    const credited = parseLyrics(ttml, '', 'Uploader');
    check('TTML songwriter metadata is deduplicated across namespaces',
      credited.credits.writers.join(', ') === 'Matthew Martin, Second Writer');
    check('TTML community author takes precedence over uploader',
      credited.credits.syncers.join(', ') === 'Community Creator');
    check('API community author is used when TTML has no author',
      parseLyrics(ttml.replace('<amll:meta key="ttmlAuthor" value="Community Creator"/>', ''), '', 'Uploader')
        .credits.syncers[0] === 'Uploader');
    check('plain lyrics do not invent credits', !parseLyrics('[00:00]Plain').credits);
    view.setLyrics(credited, 5.1, 10, false);
    const creditRows = [...view.track.querySelectorAll('.is-credit')];
    check('credits are ordinary rows after the lyrics',
      view.lineElements.length === 3 && creditRows.length === 2 &&
      view.lineElements[1] === creditRows[0] && view.lineStates.length === 3);
    check('credit labels and names use bold and regular type',
      creditRows[0].textContent === 'Written by: Matthew Martin, Second Writer' &&
      creditRows[1].textContent === 'Synced by: Community Creator' &&
      getComputedStyle(creditRows[0]).fontWeight === '400' &&
      getComputedStyle(creditRows[0].querySelector('strong')).fontWeight === '700');
    let seeks = 0;
    view.onSeek = () => { seeks += 1; };
    creditRows[0].click();
    check('clicking a credit does not seek playback', seeks === 0);
    check('credits never become duet or karaoke rows', creditRows.every(row =>
      !row.classList.contains('is-duet') && !row.querySelector('.lyrics-word')));
    check('credit handoff does not shorten the final lyric', view.effectiveStarts[1] > 5);
    view.update(0.5, 10, false);
    // Blur starts with a short eased tween and is painted only above 0.1px.
    for (let frame = 0; frame < 3; frame += 1) view.stepMotion(view.lastMotionTime + 20);
    const creditBlur = row => row.style.getPropertyValue('--line-blur');
    check('both credits share a nonzero blur while lyrics are focused',
      creditBlur(creditRows[0]) === creditBlur(creditRows[1]) &&
      parseFloat(creditBlur(creditRows[0])) > 0);
    view.setReadability(true);
    view.setLineHover(1);
    for (let i = 0; i < 9; i += 1) view.stepInteractionMotion(view.lastInteractionTime + 16);
    check('hovering either credit clears both credit rows together',
      creditRows.every(row => getComputedStyle(row).filter === 'blur(0px)'));
    view.setReadability(false, true);
    view.setLineHover(-1, true);
    view.update(5.1, 10, false);
    const settleEnd = view.lastMotionTime + 1500;
    for (let t = view.lastMotionTime + 16; t <= settleEnd; t += 16) {
      view.stepMotion(t);
    }
    check('both credits become clear together when credits are focused',
      creditRows.every(row => creditBlur(row) === '0px'));
    view.setLyrics(parseLyrics('[00:00]Another track'), 0, 10, false);
    check('track changes clear the previous credits', !view.track.querySelector('.is-credit'));
    const syllables = parseLyrics(`<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
      <p begin="0s" end="4s"><span begin="0s" end="1s">Аааааа </span><span begin="1s" end="2s">ла</span><span begin="2s" end="3s">йық</span><span begin="3s" end="4s">ты</span></p>
      </div></body></tt>`);
    view.setLyrics(syllables, 0, 4, false);
    const wrapMain = view.lineElements[0].querySelector('.lyrics-main-text');
    wrapMain.style.width = '230px';
    view.lineElements[0].style.setProperty('--lyrics-font-size', '40px');
    const wrappingUnits = [...wrapMain.querySelectorAll('.lyrics-emphasis')];
    const fragments = [...wrappingUnits[1].querySelectorAll('.lyrics-word')];
    check('Kazakh syllables wrap together as a whole word',
      fragments.length === 3 && wrappingUnits[1].textContent === 'лайықты' &&
      fragments.every(fragment => Math.abs(fragment.getBoundingClientRect().top -
        fragments[0].getBoundingClientRect().top) < 0.5) &&
      fragments[0].getBoundingClientRect().top > wrappingUnits[0].getBoundingClientRect().top + 10);
    check('wrapping preserves separate syllable timing',
      view.wordMotions[0].map(plan => plan.start).join(',') === '0,1,2,3');
    check('CJK retains its existing character wrapping',
      !view.buildChunk([{ text: '你好世界', time: 0, end: 2 }]).wrapper.classList.contains('is-unbreakable'));
    check('long words retain their overflow wrapping',
      !view.buildChunk([{ text: 'averylongunbrokentoken', time: 0, end: 2 }]).wrapper.classList.contains('is-unbreakable'));
    // Arabic is written right to left and takes its own face, so the row, its
    // karaoke band and its word boxes all have to mirror while the app's own
    // copy stays left to right.
    await document.fonts.load('900 40px "SF Arabic"');
    await document.fonts.ready;
    const arabic = parseLyrics('<tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
      '<p begin="0s" end="4s"><span begin="0s" end="2s">يا </span>' +
      '<span begin="2s" end="4s">حبيبي</span></p></div></body></tt>');
    view.setLyrics(arabic, 1, 4, true);
    const arabicLine = view.lineElements[0];
    const arabicWords = [...arabicLine.querySelectorAll('.lyrics-word')];
    const lineBox = arabicLine.getBoundingClientRect();
    const firstWord = arabicWords[0].getBoundingClientRect();
    const lastWord = arabicWords[arabicWords.length - 1].getBoundingClientRect();
    check('an Arabic row reads from the right',
      arabicLine.dir === 'rtl' && arabicWords.length === 2 &&
      firstWord.left > lastWord.left &&
      Math.abs(firstWord.right - lineBox.right) < 2);
    check('Arabic rows take SF Arabic',
      getComputedStyle(arabicLine).fontFamily.includes('SF Arabic') &&
      document.fonts.check('900 40px "SF Arabic"'));
    check('Arabic words stay whole instead of splitting into glyph boxes',
      arabicLine.querySelectorAll('.lyrics-char').length === 0 &&
      arabicWords.every(word => word.classList.contains('is-rtl')));
    const maskOf = element => {
      const style = getComputedStyle(element);
      return String(style.maskImage || style.webkitMaskImage);
    };
    view.update(1, 4, true);
    check('the Arabic karaoke band sweeps right to left',
      /to left/.test(maskOf(arabicWords[0])));
    const latinRow = parseLyrics('<tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
      '<p begin="0s" end="4s"><span begin="0s" end="2s">Moonlight </span>' +
      '<span begin="2s" end="4s">shining</span></p></div></body></tt>');
    view.setLyrics(latinRow, 1, 4, true);
    const latinLine = view.lineElements[0];
    const latinWords = [...latinLine.querySelectorAll('.lyrics-word')];
    check('a Latin row keeps the app direction and SF Pro Display',
      latinLine.dir === '' &&
      !latinLine.classList.contains('is-arabic') &&
      getComputedStyle(latinLine).fontFamily.startsWith('"SF Pro Display"'));
    view.update(1, 4, true);
    check('the Latin karaoke band still sweeps left to right',
      latinWords.length === 2 && /to right/.test(maskOf(latinWords[0])));
    // A one-letter final word is an ordinary word: it takes the same emphasis
    // as any other unit and never gets a second copy of its glyphs.
    const dupLine = {
      text: 'I can see the I',
      end: 2.8,
      words: [
        { text: 'I', start: 0.00, end: 0.18 },
        { text: 'can', start: 0.18, end: 0.55 },
        { text: 'see', start: 0.55, end: 0.82 },
        { text: 'the', start: 0.82, end: 1.05 },
        { text: 'I', start: 1.05, end: 1.30 }
      ]
    };
    view.setLyrics([dupLine, { time: 3, end: 5, text: 'Following line' }], 1.25, 6, true);
    check('a terminal single-glyph word draws no second copy of its glyphs',
      view.lineElements[0].querySelectorAll('.lyrics-char-duplicate').length === 0 &&
      view.lineElements[0].textContent === 'I can see the I');
    view.setLyrics([{
      text: 'my party',
      time: 204,
      end: 211,
      words: [
        { text: 'my ', start: 204, end: 205.252 },
        { text: 'part', start: 205.252, end: 205.935 },
        { text: 'y', start: 205.935, end: 210.488 }
      ]
    }], 207, 215, true);
    check('part + y share one chunk with no cloned overlay',
      view.lineElements[0].querySelectorAll('.lyrics-emphasis').length >= 1 &&
      view.lineElements[0].querySelectorAll('.lyrics-char-duplicate').length === 0 &&
      view.lineElements[0].textContent === 'my party');
    view.setLyrics([{
      text: 'party',
      time: 204,
      end: 211,
      words: [{ text: 'party', start: 204, end: 211 }]
    }], 207, 215, true);
    const partyGlyphs = [...view.lineElements[0].querySelectorAll('.lyrics-char')];
    const partyMotion = () => partyGlyphs.map((el) => el.parentElement.style.transform);
    view.update(206.5, 215, true);
    const partyEarly = partyMotion();
    view.update(208, 215, true);
    const partyLate = partyMotion();
    check('an emphasised word still runs its ordinary per-letter cascade',
      partyGlyphs.length === 5 &&
      partyEarly.every((value) => value && value !== 'translate3d(0px, 0px, 0px) scale(1.0000)') &&
      partyLate.some((value, index) => value !== partyEarly[index]));
    view.setLyrics(latinRow, 1, 4, true);
    // Sheets and UI switches temporarily scale the player. Measuring at that
    // scale must not feed screen pixels into a spring that uses layout pixels.
    view.reduceMotion = { matches: true };
    view.element.style.transition = 'none';
    for (const scale of [.95, 1.2, 1]) {
      view.element.style.transform = `scale(${scale})`;
      view.refreshMetrics();
      view.stepMotion(performance.now(), true);
      const row = view.lineElements[0].querySelector('.lyrics-main-text').getBoundingClientRect();
      const expected = view.track.getBoundingClientRect().top + innerHeight * .3815 * scale;
      check(`parent scale ${scale} retains the desktop lyric anchor`, Math.abs(row.top + row.height / 2 - expected) < .5,
        { actual: row.top + row.height / 2, expected });
    }
    view.element.style.removeProperty('transform');
    view.element.style.removeProperty('transition');

    view.reduceMotion = { matches: false };
    const scaleLines = [
      { time: 1.0, end: 1.5, text: 'lead one', words: [{ time: 1.0, end: 1.5, text: 'lead one' }] },
      { time: 1.6, end: 2.1, text: 'lead two', words: [{ time: 1.6, end: 2.1, text: 'lead two' }] },
      { time: 2.2, end: 2.7, text: 'bg line', words: [{ time: 2.2, end: 2.7, text: 'bg line' }] },
      { time: 2.8, end: 3.5, text: 'lead four', words: [{ time: 2.8, end: 3.5, text: 'lead four' }] },
      { time: 4.5, end: 5.5, text: 'lead five', words: [{ time: 4.5, end: 5.5, text: 'lead five' }] }
    ];
    scaleLines.credits = { writers: ['Test Writer'], syncers: [] };
    view.setLineScale(true);
    view.setLyrics(scaleLines, 1.2, 10, true);
    view.lines[2].isBackground = true;
    view.syncLineScales(true);
    check('line scale targets match Apple Music for active lead, inactive lead, inactive background, and credit',
      view.lineStates[0].scale.target === 1 &&
      view.lineStates[1].scale.target === 0.98 &&
      view.lineStates[2].scale.target === 0.63 &&
      view.lineStates[5].scale.target === 1,
      { targets: view.lineStates.map(state => state.scale.target) });

    view.update(1.7, 10, true);
    check('urgent lead line becoming active uses row movement spring without stagger',
      view.lineStates[1].scale.stiffness === view.lineStates[1].y.stiffness &&
      view.lineStates[1].scale.damping === view.lineStates[1].y.damping &&
      view.lineStates[1].scale.queuedDelay === view.lineStates[1].y.queuedDelay &&
      view.lineStates[1].y.queuedDelay === 0 &&
      view.lineStates[1].scale.target === 1,
      {
        scaleStiffness: view.lineStates[1].scale.stiffness,
        yStiffness: view.lineStates[1].y.stiffness,
        scaleDamping: view.lineStates[1].scale.damping,
        yDamping: view.lineStates[1].y.damping,
        scaleDelay: view.lineStates[1].scale.queuedDelay,
        yDelay: view.lineStates[1].y.queuedDelay,
        queuedTarget: view.lineStates[1].scale.queuedTarget
      });
    check('lead line becoming inactive uses row movement spring immediately',
      view.lineStates[0].scale.stiffness === view.lineStates[0].y.stiffness &&
      view.lineStates[0].scale.damping === view.lineStates[0].y.damping &&
      view.lineStates[0].scale.queuedDelay === 0 &&
      view.lineStates[0].scale.target === 0.98,
      {
        scaleStiffness: view.lineStates[0].scale.stiffness,
        yStiffness: view.lineStates[0].y.stiffness,
        scaleDamping: view.lineStates[0].scale.damping,
        yDamping: view.lineStates[0].y.damping,
        scaleDelay: view.lineStates[0].scale.queuedDelay,
        target: view.lineStates[0].scale.target
      });

    view.update(2.3, 10, true);
    check('active background line targets 0.7 with activeScaleSpring and row stagger delay',
      view.lineStates[2].scale.queuedTarget === 0.7 &&
      view.lineStates[2].scale.stiffness === 30 &&
      view.lineStates[2].scale.damping === 9 &&
      view.lineStates[2].scale.queuedDelay === view.lineStates[2].y.queuedDelay &&
      view.lineStates[2].y.queuedDelay > 0,
      {
        queuedTarget: view.lineStates[2].scale.queuedTarget,
        stiffness: view.lineStates[2].scale.stiffness,
        damping: view.lineStates[2].scale.damping,
        scaleDelay: view.lineStates[2].scale.queuedDelay,
        yDelay: view.lineStates[2].y.queuedDelay
      });

    view.update(2.9, 10, true);
    const omega = (2 * Math.PI) / 0.55;
    const expectedInactiveStiffness = omega * omega;
    const expectedInactiveDamping = 2 * omega;
    check('inactive background line keeps its critically damped 0.55s spring during urgent movement',
      Math.abs(view.lineStates[2].scale.stiffness - expectedInactiveStiffness) < 1e-6 &&
      Math.abs(view.lineStates[2].scale.damping - expectedInactiveDamping) < 1e-6 &&
      view.lineStates[2].scale.queuedDelay === view.lineStates[2].y.queuedDelay &&
      (view.lineStates[2].scale.queuedTarget ?? view.lineStates[2].scale.target) === 0.63,
      {
        stiffness: view.lineStates[2].scale.stiffness,
        damping: view.lineStates[2].scale.damping,
        scaleDelay: view.lineStates[2].scale.queuedDelay,
        yDelay: view.lineStates[2].y.queuedDelay,
        queuedTarget: view.lineStates[2].scale.queuedTarget,
        target: view.lineStates[2].scale.target
      });

    view.update(4.7, 10, true);
    check('seeking uses seekSpring for scale transitions',
      view.lineStates[4].scale.target === 1 &&
      view.lineStates[4].scale.stiffness === 100 &&
      view.lineStates[4].scale.damping === 18 &&
      view.lineStates[3].scale.target === 0.98 &&
      view.lineStates[3].scale.stiffness === 100 &&
      view.lineStates[3].scale.damping === 18,
      {
        activeLeadStiffness: view.lineStates[4].scale.stiffness,
        inactiveLeadStiffness: view.lineStates[3].scale.stiffness
      });

    // Drive focus independently of playback time so every alpha and blur
    // sample has an exact elapsed duration, regardless of the host frame rate.
    const transitionLines = [0, 3, 6, 9].map(time => ({
      time, end: time + 3, text: 'First second', words: [
        { time, end: time + 1, text: 'First ' },
        { time: time + 2, end: time + 3, text: 'second' }
      ]
    }));
    view.setLyrics(transitionLines, 0.5, 12, true);
    const focusLine = (index, options = {}) => {
      view.activeIndex = index;
      view.anchorIndex = index;
      view.activeIndices = [index];
      view.applyClasses([index]);
      view.updateTargets(index, options);
      view.stepMotion(view.lastMotionTime, true);
    };
    const advance = milliseconds => view.stepMotion(view.lastMotionTime + milliseconds, true);
    focusLine(2, { position: 8.099 });
    check('timed vocal with more than 0.9 seconds remaining keeps the movement cascade',
      view.lineStates[2].y.queuedDelay > 0);
    const pendingMovementDelay = view.lineStates[2].y.queuedDelay;
    view.updateTargets(2, { position: 8.101, preserveDelay: true });
    check('layout-only updates preserve a pending cascade even near a vocal ending',
      view.lineStates[2].y.queuedDelay === pendingMovementDelay);
    view.updateTargets(2, { position: 8.101 });
    check('timed vocal with less than 0.9 seconds remaining releases every movement delay',
      view.lineStates.every(state => state.y.queuedDelay === 0 && state.y.queuedTarget === null));
    for (const flag of ['isBackground', 'isCredit']) {
      view.lines[2][flag] = true;
      view.updateTargets(2, { position: 8.101 });
      check(flag + ' does not suppress the movement cascade near its ending',
        view.lineStates[2].y.queuedDelay > 0);
      view.lines[2][flag] = false;
    }
    const timedWords = view.lines[2].words;
    view.lines[2].words = [];
    view.updateTargets(2, { position: 8.101 });
    check('an untimed line keeps the movement cascade near its ending',
      view.lineStates[2].y.queuedDelay > 0);
    view.lines[2].words = timedWords;
    view.setLyrics(transitionLines, 0.5, 12, true);
    const displayedAlpha = index => {
      const row = view.lineElements[index];
      const bright = Number(getComputedStyle(row).opacity);
      return { bright, dim: bright * Number(getComputedStyle(row).getPropertyValue('--word-dark-alpha')) };
    };
    check('active timed text has independent absolute bright and dim alpha',
      Math.abs(displayedAlpha(0).bright - 0.85) < 0.0001 &&
      Math.abs(displayedAlpha(0).dim - 0.3) < 0.0001);
    focusLine(1);
    const incoming = view.lineStates[1];
    const outgoing = view.lineStates[0];
    const incomingBlur = incoming.blur.value;
    check('incoming bright text activates immediately while dim text retains its current alpha',
      displayedAlpha(1).bright === 0.85 && Math.abs(displayedAlpha(1).dim - 0.175) < 0.0001);
    check('alpha and blur do not inherit the row movement stagger',
      incoming.y.queuedDelay > 0 && incoming.opacity.queuedDelay === 0 &&
      incoming.wordOpacity.queuedDelay === 0 && incoming.blur.target === 0);
    check('ordinary alpha uses the default spring before urgency compression',
      outgoing.opacity.stiffness === 100 && outgoing.opacity.damping === 10 &&
      incoming.wordOpacity.stiffness === 100 && incoming.wordOpacity.damping === 10);
    check('deactivation retains both the last displayed alpha and the karaoke mask',
      displayedAlpha(0).bright === 0.85 && Math.abs(displayedAlpha(0).dim - 0.3) < 0.0001 &&
      getComputedStyle(view.lineElements[0].querySelector('.lyrics-char, .lyrics-word:not(.has-chars)')).maskImage !== 'none',
      displayedAlpha(0));
    advance(20);
    check('blur starts in both directions before the incoming row stagger expires',
      outgoing.blur.value > 0 && incoming.blur.value < incomingBlur && incoming.y.queuedDelay > 0);
    advance(20);
    advance(20);
    check('blur midpoint follows its cubic curve at 60ms',
      Math.abs(outgoing.blur.value / outgoing.blur.target - 0.3955512969072905) < 0.000001 &&
      Math.abs(incoming.blur.value / incomingBlur - (1 - 0.3955512969072905)) < 0.000001);
    const alphaMidpoint = displayedAlpha(0);
    check('outgoing bright and dim text both dim without a mask-removal flash',
      alphaMidpoint.bright < 0.85 && alphaMidpoint.bright > 0.175 &&
      alphaMidpoint.dim < 0.3 && alphaMidpoint.dim > 0.175);
    view.updateTargets(1, { preserveDelay: true });
    check('layout-only retargeting preserves blur elapsed time', Math.abs(outgoing.blur.elapsed - 0.06) < 0.000001);
    for (let frame = 0; frame < 3; frame += 1) advance(20);
    check('blur completes at 120ms in both directions',
      outgoing.blur.value === outgoing.blur.target && incoming.blur.value === 0);
    let alphaInRange = true;
    for (let frame = 0; frame < 120; frame += 1) {
      advance(20);
      const alpha = displayedAlpha(0);
      alphaInRange &&= alpha.bright >= 0.175 && alpha.bright <= 0.85 &&
        alpha.dim >= 0.1749 && alpha.dim <= 0.3001;
    }
    check('painted alpha stays within transition endpoints despite spring overshoot', alphaInRange);
    check('inactive timed text converges to a uniform alpha',
      displayedAlpha(0).bright === 0.175 && Math.abs(displayedAlpha(0).dim - 0.175) < 0.0001,
      displayedAlpha(0));
    focusLine(2, { seek: true });
    advance(20);
    const interruptedBlur = view.lineStates[2].blur.value;
    focusLine(1, { seek: true });
    check('interrupting blur retargets from its displayed radius',
      view.lineStates[2].blur.value === interruptedBlur);
    for (let frame = 0; frame < 6; frame += 1) advance(20);
    check('seeking keeps the same 120ms blur duration',
      view.lineStates[2].blur.value === view.lineStates[2].blur.target);
    focusLine(2, { position: 8.3 });
    check('an imminent ending selects the fixed critically damped alpha response',
      Math.abs(view.lineStates[2].wordOpacity.stiffness - (Math.log(100) / 0.3) ** 2) < 0.000001);
    view.reduceMotion = { matches: true };
    advance(20);
    check('reduced motion settles both alpha channels and blur immediately',
      view.lineStates.every(state => state.opacity.value === state.opacity.target &&
        state.wordOpacity.value === state.wordOpacity.target && state.blur.value === state.blur.target));
    view.reduceMotion = { matches: false };
    const previousBackingAcceleration = view.accelerateFill;
    view.setAccelerateFill(false);
    view.setLyrics([
      { time: 0, end: 2, text: 'Opening voice' },
      { time: 2, end: 6, text: 'Lead continues', words: [
        { time: 2, end: 3, text: 'Lead ' }, { time: 3, end: 6, text: 'continues' }
      ], backgroundText: 'Oh yeah', backgroundWords: [
        { time: 2.25, end: 4.25, text: 'Oh ' }, { time: 4.8, end: 5.1, text: 'yeah' }
      ] },
      { time: 6, end: 9, text: 'Following voice' }
    ], 1.8, 10, true);
    view.update(2.01, 10, true);
    const backing = view.backgroundStates[1];
    const backingPlans = view.backgroundWordMotions[1];
    check('backing words have independent motion plans without entering the lead fill geometry',
      backingPlans.length === 2 && view.wordElements[1].length === 2 &&
      backingPlans.every(plan => plan.params === null && plan.chars === null) &&
      !backing.element.querySelector('.lyrics-char-glow'));
    check('backing entrance starts immediately with a soft alpha and reveal spring',
      backing.slide.queuedDelay === 0 && backing.opacity.queuedDelay === 0 &&
      backing.slide.stiffness === 30 && backing.slide.damping === 9 &&
      backing.opacity.stiffness === 30 && backing.opacity.damping === 9);
    advance(20);
    check('backing entrance reveals height and alpha continuously',
      backing.slot.getBoundingClientRect().height > 0 && backing.slot.getBoundingClientRect().height < backing.height &&
      backing.opacity.value > 0 && backing.opacity.value < 0.3);
    for (let frame = 0; frame < 100; frame += 1) advance(20);
    check('backing brightness reaches its own alpha without being dimmed twice',
      Math.abs(Number(getComputedStyle(backing.element).opacity) *
        Number(getComputedStyle(view.lineElements[1]).opacity) - 0.3) < 0.001);
    view.updateBackgroundLineFill(1, 2.15);
    const unsungBackingFill = backingPlans[0].element.__fill;
    view.updateBackgroundLineFill(1, 3.2);
    view.updateBackgroundWordMotion(3.2, [1]);
    const sungBackingTransform = backingPlans[0].element.style.transform;
    const sungBackingFill = backingPlans[0].element.__fill;
    check('backing words fill and lift on their own timing without scale, spread or glow',
      sungBackingFill > unsungBackingFill &&
      new DOMMatrix(getComputedStyle(backingPlans[0].element).transform).m42 < 0 &&
      new DOMMatrix(getComputedStyle(backingPlans[0].element).transform).m11 === 1 &&
      new DOMMatrix(getComputedStyle(backingPlans[0].element).transform).m41 === 0 &&
      backingPlans[1].element.style.transform === 'translate3d(0px, 0px, 0px)' &&
      getComputedStyle(backingPlans[0].element).maskImage !== 'none',
      { sungBackingTransform, sungBackingFill, unsungBackingFill,
        laterTransform: backingPlans[1].element.style.transform });
    view.updateBackgroundLineFill(1, 2.15);
    view.updateBackgroundWordMotion(2.15, [1]);
    view.updateBackgroundLineFill(1, 3.2);
    view.updateBackgroundWordMotion(3.2, [1]);
    check('revisiting a backing word restores the exact fill and motion frame',
      backingPlans[0].element.style.transform === sungBackingTransform &&
      backingPlans[0].element.__fill === sungBackingFill);
    const backingAlphaBeforeExit = backing.opacity.value;
    view.syncBackgroundTargets([]);
    check('backing exit preserves the displayed word pose and selects the damped response',
      backingPlans[0].element.style.transform === sungBackingTransform &&
      backing.opacity.value === backingAlphaBeforeExit &&
      Math.abs(backing.opacity.stiffness - ((2 * Math.PI) / 0.55) ** 2) < 0.000001);
    advance(20);
    check('backing exit fades continuously without discarding the karaoke mask',
      backing.opacity.value > 0 && backing.opacity.value < backingAlphaBeforeExit &&
      getComputedStyle(backingPlans[0].element).maskImage !== 'none');
    const interruptedBacking = [backing.slide.value, backing.slide.velocity, backing.opacity.value, backing.opacity.velocity];
    view.syncBackgroundTargets([1]);
    check('interrupting a backing exit preserves the reveal and alpha position and velocity',
      [backing.slide.value, backing.slide.velocity, backing.opacity.value, backing.opacity.velocity]
        .every((value, index) => value === interruptedBacking[index]));
    view.reduceMotion = { matches: true };
    view.updateBackgroundWordMotion(3.2, [1]);
    advance(20);
    check('reduced motion settles the backing reveal and clears word motion',
      backing.slide.value === 0 && backing.opacity.value === 0.3 &&
      backingPlans.every(plan => plan.element.style.transform === ''));
    view.reduceMotion = { matches: false };
    view.setAccelerateFill(previousBackingAcceleration);
    view.setLineScale(false);
    let hoverSeek = null;
    view.onSeek = time => { hoverSeek = time; };
    view.setLyrics([
      { time: 0, end: 3, text: 'Current phrase', words: [
        { time: 0, end: 1.5, text: 'Current ' }, { time: 1.5, end: 3, text: 'phrase' }
      ] },
      { time: 3, end: 6, text: 'A longer wrapped phrase for the next lyric' },
      { time: 6, end: 8, text: 'Another inactive lyric' }
    ], .5, 8, false);
    const hoveringRow = view.lineElements[1];
    const singingMask = view.lineElements[0].style.getPropertyValue('--word-dark-alpha');
    const originalHoverLayout = [hoveringRow.offsetWidth, hoveringRow.offsetHeight, view.lineElements[0].offsetTop];
    view.element.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    const pointerStep = (frames = 1) => {
      for (let i = 0; i < frames; i += 1) view.stepInteractionMotion(view.lastInteractionTime + 1000 / 60);
    };
    const alpha = index => Number(view.lineElements[index].style.getPropertyValue('--line-opacity'));
    const radius = index => parseFloat(view.lineElements[index].style.getPropertyValue('--line-blur'));
    view.stepInteractionMotion(view.lastInteractionTime + 15);
    check('container hover unblurs every inactive row through an intermediate radius',
      [1, 2].every(index => radius(index) > 0 && radius(index) < view.lineStates[index].blur.value));
    check('container hover brightens every inactive row progressively without changing the active row',
      alpha(1) > .175 && alpha(1) < .35 && alpha(2) === alpha(1) && alpha(0) === .85);
    view.stepInteractionMotion(view.lastInteractionTime + 15.01);
    check('container hover clears every inactive row within 30 ms without a row target',
      radius(1) === 0 && radius(2) === 0 && view.hoverIndex === -1);
    check('all inactive rows settle at readability opacity within 30 ms', alpha(1) === .35 && alpha(2) === .35,
      { first: alpha(1), second: alpha(2), readability: view.readability.value });
    hoveringRow.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    const hoverPlate = view.hoverElement;
    pointerStep(2);
    check('all inactive text stays crisp throughout container hover', radius(1) === 0 && radius(2) === 0);
    check('pointer hover shows a padded translucent white plate outside the text group',
      hoverPlate.parentElement === view.track && !hoveringRow.contains(hoverPlate) &&
      hoverPlate.classList.contains('is-visible') &&
      getComputedStyle(hoverPlate, '::before').backgroundColor === 'rgba(255, 255, 255, 0.08)' &&
      getComputedStyle(hoverPlate).filter === 'none' && Number.parseFloat(getComputedStyle(hoverPlate, '::before').borderRadius) > 0);
    check('hover plate does not change wrapping or capture lyric clicks',
      originalHoverLayout.every((value, i) => value === [hoveringRow.offsetWidth, hoveringRow.offsetHeight, view.lineElements[0].offsetTop][i]) &&
      getComputedStyle(hoverPlate).pointerEvents === 'none');
    view.lineStates[1].y.jump(123);
    view.renderLinePosition(view.lineStates[1], true);
    check('hover plate follows the same row spring transform', hoverPlate.style.transform === hoveringRow.style.transform);
    hoveringRow.click();
    check('hovered lyric still seeks to its timestamp', hoverSeek === 3);
    hoveringRow.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    pointerStep(3);
    check('moving into a container gap keeps all inactive text crisp', radius(1) === 0 && radius(2) === 0);
    check('pointer exit removes the hover plate', !hoverPlate.classList.contains('is-visible'));
    view.lineElements[0].dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    check('the singing line can be highlighted without changing its karaoke state',
      view.hoverElement.classList.contains('is-visible') && view.lineElements[0].classList.contains('is-active') &&
      alpha(0) === .85 && view.lineElements[0].style.getPropertyValue('--word-dark-alpha') === singingMask);
    pointerStep(4);
    check('moving between lyrics crossfades separate plates without teleporting a visible plate',
      !hoverPlate.hidden && !view.hoverElement.hidden && hoverPlate !== view.hoverElement &&
      Number(hoverPlate.style.opacity) > 0 && Number(view.hoverElement.style.opacity) > 0);
    const press = (index, pointerId = 7) => view.lineElements[index].dispatchEvent(new PointerEvent('pointerdown',
      { pointerType: 'mouse', button: 0, pointerId, isPrimary: true }));
    press(0);
    const pressSamples = pointerFixture.press.map(() => { pointerStep(); return view.lineStates[0].press.value; });
    check('press trajectory matches the extracted spring samples',
      pressSamples.every((value, i) => Math.abs(value - pointerFixture.press[i]) < 1e-10));
    const pressRect = view.lineElements[0].getBoundingClientRect();
    const pressedTop = view.lineElements[0].offsetTop;
    check('press works with line scaling disabled and keeps the highlight attached',
      view.lineStates[0].press.value < .95 && !view.lineScale &&
      view.hoverElement.style.transform === view.lineElements[0].style.transform);
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 99 }));
    check('another pointer cannot release a held lyric', view.pressedIndex === 0);
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7 }));
    const releaseSamples = pointerFixture.release.map(() => { pointerStep(); return view.lineStates[0].press.value; });
    check('release trajectory preserves velocity and matches the extracted return samples',
      releaseSamples.every((value, i) => Math.abs(value - pointerFixture.release[i]) < 1e-10));
    pointerStep(100);
    const releaseRect = view.lineElements[0].getBoundingClientRect();
    check('press returns to rest without a layout shift or a sideways pivot',
      view.lineStates[0].press.value === 1 && pressedTop === view.lineElements[0].offsetTop &&
      Math.abs(pressRect.x + pressRect.width / 2 - releaseRect.x - releaseRect.width / 2) < .05);
    press(1);
    pointerStep(5);
    const interruption = view.lineStates[1].press.value;
    hoveringRow.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    check('dragging off releases from the displayed scale',
      view.pressedIndex === -1 && view.lineStates[1].press.target === 1 && view.lineStates[1].press.value === interruption);
    hoverSeek = null;
    hoveringRow.dispatchEvent(new MouseEvent('click', { detail: 1 }));
    check('dragging off a lyric cannot seek', hoverSeek === null);
    press(1);
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 7 }));
    hoveringRow.dispatchEvent(new MouseEvent('click', { detail: 1 }));
    check('cancelled presses cannot seek', hoverSeek === null && view.pressedIndex === -1);
    view.element.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    const beforeExit = alpha(2);
    view.stepInteractionMotion(view.lastInteractionTime + 15);
    check('container exit restores distance blur through an intermediate radius',
      [1, 2].every(index => radius(index) > 0 && radius(index) < view.lineStates[index].blur.value));
    check('leaving fades all inactive rows back progressively', alpha(2) < beforeExit && alpha(2) > .175);
    view.stepInteractionMotion(view.lastInteractionTime + 15.01);
    check('container exit restores distance blur within 30 ms',
      [1, 2].every(index => Math.abs(radius(index) - view.lineStates[index].blur.value) < .0001));
    check('container exit restores resting line opacity within 30 ms', alpha(2) === .175);
    pointerStep(100);
    check('hover exit restores opacity and blur', alpha(2) === .175 && radius(1) > 0);
    // Let the pointer's own animation clock run while the lyric clock is idle.
    const playbackClock = view.lastMotionTime;
    hoveringRow.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    const beforePausedHover = alpha(2);
    await new Promise(resolve => setTimeout(resolve, 90));
    check('hover animates during pause without advancing the lyric clock',
      alpha(2) > beforePausedHover && view.lastMotionTime === playbackClock);
    view.reduceMotion = { matches: true };
    view.setLineHover(1);
    view.setReadability(true);
    press(1);
    pointerStep();
    check('reduced motion applies readability and blur immediately without press scaling',
      alpha(2) === .35 && radius(1) === 0 && view.lineStates[1].press.value === 1);
    view.reduceMotion = { matches: false };
    view.setInteractionEnabled(false);
    check('disabled lyric interaction immediately removes the hover plate', hoverPlate.hidden);
    view.setInteractionEnabled(true);
    hoveringRow.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'touch' }));
    check('touch input cannot leave a sticky hover plate', hoverPlate.hidden);
    view.onSeek = null;
    view.setLyrics(credited, 5.1, 10, false);
    return checks;
  } finally {
    view.resizeObserver.disconnect();
    if (!window.__keepCreditPreview) view.clear();
  }
}

async function runElectron() {
  const { app, BrowserWindow, session } = require('electron');
  const profile = process.env.YOURLYRICS_LAYOUT_PROFILE;
  if (!profile || !path.basename(profile).startsWith('yourlyrics-layout-')) {
    throw new Error('Missing disposable test profile');
  }
  for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) app.setPath(name, profile);
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  const deadline = setTimeout(() => { console.error('Renderer test timed out'); app.exit(2); }, 25000);
  try {
    await app.whenReady();
    const renderer = path.join(repo, 'src/renderer');
    const base = pathToFileURL(renderer + path.sep).href;
    const fixture = pathToFileURL(path.join(profile, 'fixture.html')).href;
    const assets = new Map();
    for (const [file, type] of [
      [path.join(renderer, 'lyrics/index.js'), 'text/javascript'],
      [path.join(renderer, 'lyrics/parsers.js'), 'text/javascript'],
      [path.join(renderer, 'styles/styles.css'), 'text/css'],
      ...['Regular', 'Medium', 'Bold', 'Heavy'].map(weight =>
        [path.join(repo, 'assets/fonts', `SF-Pro-Display-${weight}.otf`), 'font/otf']),
      [path.join(repo, 'assets/fonts/SF-Arabic.ttf'), 'font/ttf']
    ]) assets.set(pathToFileURL(file).href, { bytes: fs.readFileSync(file), type });
    assets.set(fixture, { type: 'text/html', bytes: `<!doctype html><html><head>
      <meta charset="utf-8"><base href="${base}"><link rel="stylesheet" href="styles/styles.css">
      </head><body><div class="lyrics"><div class="lyrics-mask"><div class="lyrics-track"></div></div></div></body></html>` });
    const isolated = session.fromPartition(`lyrics-layout-${process.pid}`, { cache: false });
    const blocked = [];
    isolated.webRequest.onBeforeRequest((details, callback) => {
      if (!assets.has(details.url)) blocked.push(details.url);
      callback({ cancel: !assets.has(details.url) });
    });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.protocol.handle('file', request => {
      const asset = assets.get(request.url);
      return asset ? new Response(asset.bytes, { headers: { 'content-type': asset.type } }) :
        new Response('Not a test asset', { status: 403 });
    });
    const win = new BrowserWindow({ show: false, width: 1000, height: 800, useContentSize: true,
      webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true,
        sandbox: true, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadURL(fixture);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
    });
    if (process.env.YOURLYRICS_CREDIT_PREVIEW) {
      await win.webContents.executeJavaScript('window.__keepCreditPreview = true');
    }
    const results = await win.webContents.executeJavaScript(
      `(${checkRenderer.toString()})(${JSON.stringify(base + 'lyrics/index.js')}, ${fs.readFileSync(path.join(repo, 'tests/fixtures/wrapped-fill.json'), 'utf8')}, ${fs.readFileSync(path.join(repo, 'tests/fixtures/lyric-pointer-motion.json'), 'utf8')})`);
    results.push({ name: 'only synthetic local assets loaded', ok: blocked.length === 0, details: blocked });
    for (const result of results) console.log(JSON.stringify(result));
    const failures = results.filter(result => !result.ok);
    console.log(`${results.length - failures.length} passed; ${failures.length} failed`);
    if (process.env.YOURLYRICS_CREDIT_PREVIEW) {
      await new Promise(resolve => setTimeout(resolve, 150));
      fs.writeFileSync(process.env.YOURLYRICS_CREDIT_PREVIEW, (await win.webContents.capturePage()).toPNG());
    }
    win.destroy();
    app.exit(failures.length ? 1 : 0);
  } finally {
    clearTimeout(deadline);
  }
}

if (process.versions.electron) {
  runElectron().catch(error => { console.error(error); require('electron').app.exit(2); });
} else {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yourlyrics-layout-'));
  try {
    const env = { ...process.env, YOURLYRICS_LAYOUT_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const result = spawnSync(require('electron'), [__filename], {
      env, stdio: 'inherit', timeout: 30000, killSignal: 'SIGKILL'
    });
    if (result.error) console.error(result.error);
    process.exitCode = result.status ?? 2;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
