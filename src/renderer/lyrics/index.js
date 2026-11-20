import { groupBackgroundLines } from './parsers.js';
export { parseTtml, parseQrc, parseLyrics, parseLrc } from './parsers.js';

// Row timing constants use seconds, independently of the karaoke fill clock.
const lineDelay = 0.05;         // +144  50 ms per visible line, constant
const maxEndTimeOffset = 0.5;   // +152  cap on an inferred line end
const animationHeadstart = 0.5; // How early a line change begins, in seconds.
const fillAccelerationDuration = 0.25;
const minInterludeGap = 7;      // +464  instrumentalBreakVisualizationMinSeconds
const interludeTail = 0.5;        // dots clear half a second before the next line

function findInterludeGaps(lines) {
  const gaps = [];
  let maxEnd = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.isCredit) continue;
    if (index === 0 || maxEnd > 0) {
      if (line.time - maxEnd >= minInterludeGap) {
        gaps.push({
          before: index,
          start: maxEnd,
          // The next line starts focusing at line.time - 1, so clear the
          // dots then instead of leaving them under the incoming line.
          end: line.time - interludeTail
        });
      }
    }

    if (Number.isFinite(line.end) && line.end > line.time) {
      maxEnd = Math.max(maxEnd, line.end);
    }
  }

  return gaps;
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function easeOutExpo(value) {
  return value === 1 ? 1 : 1 - 2 ** (-10 * value);
}

function easeInOutBack(value) {
  const c1 = 1.70158;
  const c2 = c1 * 1.525;
  return value < 0.5
    ? ((2 * value) ** 2 * ((c2 + 1) * 2 * value - c2)) / 2
    : ((2 * value - 2) ** 2 * ((c2 + 1) * (value * 2 - 2) + c2) + 2) / 2;
}

function setStyleIfChanged(element, property, value) {
  if (element.style[property] !== value) {
    element.style[property] = value;
  }
}

function createInterludeElement() {
  const element = document.createElement('div');
  element.className = 'lyrics-interlude';
  element.setAttribute('aria-hidden', 'true');

  const group = document.createElement('div');
  group.className = 'lyrics-interlude-dots';
  const dots = [];
  for (let index = 0; index < 3; index += 1) {
    const dot = document.createElement('span');
    dot.className = 'lyrics-interlude-dot';
    group.append(dot);
    dots.push(dot);
  }
  element.append(group);

  return { element, group, dots };
}

// The last word's vocal end bounds the row handoff when a line has trailing
// silence. The highlight's final soft edge can finish on its own clock.
function lineFillDone(line, fallback) {
  let done = -Infinity;
  for (const word of line.words ?? []) {
    if (Number.isFinite(word.end)) {
      done = Math.max(done, word.end);
    }
  }
  return Number.isFinite(done) ? Math.max(done, line.time) : fallback;
}

function effectiveStartAt(lines, index, headstart) {
  if (lines[index].isCredit) return lines[index].time;
  const line = lines[index];
  if (index <= 0) {
    return line.time;
  }
  const previous = lines[index - 1];
  if (!(Number.isFinite(previous.end) && previous.end > previous.time)) {
    return line.time;
  }
  const gap = line.time - previous.end;
  if (gap >= 1) {
    return line.time - 1;
  }
  if (gap > 0) {
    // Begin moving shortly before the outgoing vocal ends. Short lines get
    // a smaller lead so they still have time in focus. This moves the rows;
    // the outgoing highlight keeps following its own word timings.
    const lead = Math.min(
      headstart,
      (previous.end - previous.time) / 2
    );
    return Math.max(
      line.time - 1,
      Math.min(
        previous.end - lead,
        lineFillDone(previous, previous.end)
      )
    );
  }
  return line.time;
}

function effectiveStartsFor(lines, headstart = animationHeadstart) {
  return lines.map((_, index) => effectiveStartAt(lines, index, headstart));
}

// Focus follows the row handoff, while karaoke fill has a separate clock.
// Overlapping vocals keep both rows selected until their own boundaries.
function focusEndsFor(lines, boundaryEnds, starts) {
  return lines.map((line, index) => {
    const next = lines[index + 1];
    const moveAt = starts[index + 1];
    if (next && Number.isFinite(moveAt) && moveAt < next.time) {
      return Math.min(boundaryEnds[index], moveAt);
    }
    return boundaryEnds[index];
  });
}

// The end of a line's selection window: an explicit `end` wins, otherwise the
  // next line's own start time bounds it. That is the raw timestamp, not the
// leaded effective start — a line change that begins early (the 1s scroll lead)
// must not truncate the outgoing line's fill. Never capped: the line must stay
// selected until its replacement arrives, or the gap would dim with nothing lit.
function boundaryEndsFor(lines) {
  return lines.map((line, index) => {
    if (Number.isFinite(line.end) && line.end > line.time) {
      return line.end;
    }
    const next = lines[index + 1];
    return next ? Math.max(next.time, line.time) : Infinity;
  });
}

// The moment a line stops being sung. An explicit `end` wins. An inferred end
// is bounded by the next line and by Specs.maxEndTimeOffset (0.5s): without
// word timings there is nothing to pace, so a line must not keep singing
// through a long gap. Word-timed lines keep the full boundary — their words
// already say when they stop.
function sungEndsFor(lines, boundaries) {
  return lines.map((line, index) => {
    const boundary = boundaries[index];
    if (Number.isFinite(line.end) && line.end > line.time) {
      return line.end;
    }
    if (line.words?.length) {
      return boundary;
    }
    return Math.min(boundary, line.time + maxEndTimeOffset);
  });
}

// Keep the newest line and its most recent still-sounding partner selected.
// Long overlapping end times must not accumulate an ever-growing set of
// bright, unblurred rows as playback advances through the next phrases.
function activeIndicesAt(starts, ends, position) {
  const last = activeIndexAt(starts, position);
  if (last < 0) {
    return [];
  }

  const indices = [last];
  for (let index = last - 1; index >= 0 && indices.length < 2; index -= 1) {
    // An intervening line may end before an older backing phrase or duet.
    // Its end cannot be used to stop looking for still-sounding earlier rows.
    if (ends[index] > position) {
      indices.unshift(index);
    }
  }
  return indices;
}

function activeIndexAt(starts, position) {
  let low = 0;
  let high = starts.length - 1;
  let active = -1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= position) {
      active = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return active;
}

function primaryLyricIndex(lines, indices, position) {
  let latestLead = indices[indices.length - 1] ?? -1;
  for (const index of indices) {
    const line = lines[index];
    if (!line || line.isBackground) {
      continue;
    }
    latestLead = index;
    let wordEnd = -Infinity;
    for (const word of line.words ?? []) {
      if (Number.isFinite(word.end)) {
        wordEnd = Math.max(wordEnd, word.end);
      }
    }
    // The paragraph/group end includes backing vocals. Only the lead's own
    // word timings (or original end) may hold the scroll on an earlier row.
    const leadEnd = Number.isFinite(wordEnd)
      ? wordEnd
      : line.leadEnd ?? line.end;
    if (!Number.isFinite(leadEnd) || position < leadEnd) {
      return index;
    }
  }
  return latestLead;
}

// Backing phrases attach directly to their lead row instead of taking a separate track slot.
// folds one `x-bg` paragraph into the preceding lyric and promotes any leading

// Apple Music line switch spring:
// Inter-line gap (current.startTime - prev.endTime) is mapped over [0.2s, 0.75s]:
//   t        = clamp01((gapSec - 0.2) / 0.55)
//   response = 0.48 + 0.27 * t          (0.48s -> 0.75s)
//   zeta     = 0.90 - 0.12 * t          (0.90  -> 0.78)
//   omega    = 2 * Math.PI / response
//   stiffness = omega * omega           (171.347 -> 70.1839)
//   damping   = 2 * zeta * omega        (23.5619 -> 13.069)
const snapGapMs = 200;
const longGapMs = 750;
const seekSpring = { stiffness: 100, damping: 18, mass: 1 };
const activeScaleSpring = { stiffness: 30, damping: 9, mass: 1 };
const inactiveScaleResponse = 0.55;
const inactiveScaleOmega = (2 * Math.PI) / inactiveScaleResponse;
const inactiveScaleSpring = {
  stiffness: inactiveScaleOmega * inactiveScaleOmega,
  damping: 2 * inactiveScaleOmega,
  mass: 1
};
// Bright and dim text have independent alpha springs. The 0.3-second
// critically damped response is reserved for an imminent line ending;
// ordinary alpha changes use the default spring, clamped when painted.
const opacitySpring = { stiffness: 100, damping: 10, mass: 1 };
const opacityResponse = 0.3;
const opacityOmega = 4.605170185988091 / opacityResponse;
const urgentOpacitySpring = {
  stiffness: opacityOmega * opacityOmega,
  damping: 2 * opacityOmega,
  mass: 1
};
// Pointer feedback has its own clock so it also settles while playback is paused.
const hoverSpring = { stiffness: 100, damping: 10, mass: 1 };
const pressSpring = { stiffness: 322, damping: 24, mass: 1 };
const releaseSpring = { stiffness: 300, damping: 50, mass: 2 };
const hoverOpacity = 0.35;
// Container hover brightens inactive text and clears distance blur in 30ms.
const hoverTransitionDuration = 0.03;
const blurDuration = 0.12;
const slowSpring = lineSpringParams(longGapMs);
const lineMoveSpring = slowSpring;
const maxFrameDelta = 1 / 30;
// Manual scroll tracks the wheel tightly (critically damped, no overshoot) and
// hands control back to the playing line after this much wheel silence.
const scrollSpring = { stiffness: 300, damping: 2 * Math.sqrt(300), mass: 1 };
const scrollReturnMs = 3000;

const urgentSettleThreshold = 0.8;
const urgentSettleOffset = 0.45;
const urgentSettleMin = 0.2;
const urgentSettleSlack = 0.05;
const settleLog1Percent = 4.605170185988091;

function compressSpringParams(params, timeLeft) {
  if (!Number.isFinite(timeLeft) || timeLeft >= urgentSettleThreshold) {
    return params;
  }
  const mass = params.mass;
  const omega = Math.sqrt(params.stiffness / mass);
  const zeta = Math.min(
    Math.max(params.damping / (2 * Math.sqrt(params.stiffness * mass)), 0.1),
    1
  );
  const settleTime = settleLog1Percent / (zeta * omega);
  if (settleTime - timeLeft < -urgentSettleSlack) {
    return params;
  }
  const duration = Math.max(0.01, Math.max(urgentSettleMin, timeLeft - urgentSettleOffset));
  const compressedOmega = settleLog1Percent / duration;
  const stiffness = mass * compressedOmega * compressedOmega;
  const damping = 2 * Math.sqrt(stiffness * mass);
  return { stiffness, damping, mass };
}

function lineEndTime(line, fallback) {
  if (!line) {
    return fallback;
  }
  if (Number.isFinite(line.end) && line.end > line.time) {
    return line.end;
  }
  if (line.words?.length) {
    return line.words[line.words.length - 1].end;
  }
  return fallback;
}

function lineSpringParams(intervalMs) {
  const gapMs = Number.isFinite(intervalMs) ? intervalMs : 0;
  const blend = clamp01((gapMs - snapGapMs) / (longGapMs - snapGapMs));
  const response = 0.48 + 0.27 * blend;
  const omega = (2 * Math.PI) / response;
  const stiffness = omega * omega;
  const damping = omega * (1.8 - 0.24 * blend);
  return { stiffness, damping, mass: 1 };
}

// The next row needs its full spring settling time, in addition to the fill
// sweep, before its vocal starts. The envelope uses a 0.1% settling threshold.
// Using only the spring response would start the fill preparation too late.
function lineSpringSettleTime(intervalMs) {
  const { stiffness, damping, mass } = lineSpringParams(intervalMs);
  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * mass * omega);
  return Math.log(1000 + 1000 * zeta / Math.sqrt(1 - zeta * zeta)) / (zeta * omega);
}

class SpringValue {
  constructor(value = 0, precision = 0.01) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.precision = precision;
    this.mass = slowSpring.mass;
    this.stiffness = slowSpring.stiffness;
    this.damping = slowSpring.damping;
    this.queuedTarget = null;
    this.queuedDelay = 0;
    this.elapsed = 0;
    this.delta = 0;
    this.leftover = 0;
    this.underdamped = false;
    this.omega = 0;
    this.frequency = 0;
    this.decay = 0;
    this.resetSolver();
  }

  resetSolver() {
    const delta = this.target - this.value;
    const velocity = this.velocity;
    const ratio =
      this.damping / (2 * Math.sqrt(this.stiffness * this.mass));

    this.delta = delta;
    this.elapsed = 0;

    if (ratio >= 1) {
      this.underdamped = false;
      this.omega = -Math.sqrt(this.stiffness / this.mass);
      this.leftover = -this.omega * delta - velocity;
      return;
    }

    const frequency = Math.sqrt(
      4 * this.mass * this.stiffness - this.damping * this.damping
    );

    this.underdamped = true;
    this.frequency = frequency / (2 * this.mass);
    this.decay = -this.damping / (2 * this.mass);
    this.leftover =
      (this.damping * delta - 2 * this.mass * velocity) / frequency;
  }

  configure(stiffness, damping, mass = this.mass) {
    if (
      stiffness === this.stiffness &&
      damping === this.damping &&
      mass === this.mass
    ) {
      return;
    }

    this.stiffness = stiffness;
    this.damping = damping;
    this.mass = mass;
    this.resetSolver();
  }

  jump(value) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.queuedTarget = null;
    this.queuedDelay = 0;
    this.resetSolver();
  }

  // Change coordinate origin without restarting motion or a pending stagger.
  shiftBy(delta) {
    this.value += delta;
    this.target += delta;
    if (this.queuedTarget !== null) {
      this.queuedTarget += delta;
    }
    this.resetSolver();
  }

  moveTo(value, delay = 0) {
    if (delay > 0) {
      this.queuedTarget = value;
      this.queuedDelay = delay;
      return;
    }

    this.queuedTarget = null;
    this.queuedDelay = 0;
    if (Math.abs(this.target - value) < 0.001) {
      return;
    }

    this.target = value;
    this.resetSolver();
  }

  // Re-aims a line without disturbing a stagger already in flight. A layout
  // reflow — a window resize, or the track changing height because an
  // interlude just collapsed — must not flatten a cascade into one
  // simultaneous jump, so a pending delay keeps counting down toward the
  // new target instead of being dropped.
  retarget(value) {
    if (this.queuedTarget !== null) {
      this.queuedTarget = value;
      return;
    }

    if (Math.abs(this.target - value) < 0.001) {
      return;
    }

    this.target = value;
    this.resetSolver();
  }

  advance(delta) {
    this.elapsed += delta;
    const time = this.elapsed;

    if (!this.underdamped) {
      const decay = Math.exp(this.omega * time);
      this.value =
        this.target - (this.delta + time * this.leftover) * decay;
      this.velocity =
        -decay * (this.leftover + this.omega *
          (this.delta + time * this.leftover));
      return;
    }

    const decay = Math.exp(this.decay * time);
    const angle = this.frequency * time;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    this.value =
      this.target -
      decay * (this.delta * cosine + this.leftover * sine);
    this.velocity =
      -decay * (
        (this.decay * this.delta + this.frequency * this.leftover) * cosine +
        (this.decay * this.leftover - this.frequency * this.delta) * sine
      );
  }

  update(delta) {
    if (this.queuedTarget === null && this.value === this.target && this.velocity === 0) {
      return;
    }
    let step = Math.min(Math.max(delta, 0), maxFrameDelta);
    if (step <= 0) {
      return;
    }

    if (this.queuedTarget !== null) {
      // Keep the old motion running while the stagger is still counting
      // down, then spend the remainder of this frame on the new target.
      // The native code does the same, so a delay that expires mid-frame
      // does not lose up to one frame of movement.
      const waiting = Math.min(step, this.queuedDelay);
      if (waiting > 0) {
        this.advance(waiting);
        this.queuedDelay -= waiting;
        step -= waiting;
      }

      if (this.queuedDelay <= 0) {
        const target = this.queuedTarget;
        this.queuedTarget = null;
        this.queuedDelay = 0;
        if (Math.abs(this.target - target) >= 0.001) {
          this.target = target;
          this.resetSolver();
        }
        if (step > 0) {
          this.advance(step);
        }
      }
    } else {
      this.advance(step);
    }

    if (
      this.queuedTarget === null &&
      Math.abs(this.target - this.value) < this.precision &&
      Math.abs(this.velocity) < this.precision
    ) {
      this.value = this.target;
      this.velocity = 0;
    }
  }
}

// Pointer springs stop once their small residual motion has entered the
// resting window. Keeping the row solver's much tighter text precision here
// would leave a long, barely visible tail after releasing a lyric.
class PointerSpring extends SpringValue {
  constructor(value = 0) {
    super(value, 0);
    this.configure(hoverSpring.stiffness, hoverSpring.damping, hoverSpring.mass);
  }

  update(delta) {
    super.update(delta);
    const drag = this.underdamped ? this.damping / this.mass : -2 * this.omega;
    const acceleration = (this.target - this.value) * this.stiffness / this.mass - drag * this.velocity;
    if (Math.abs(this.target - this.value) < 0.01 && this.velocity < 0.01 && acceleration < 0.01) {
      this.jump(this.target);
    }
  }
}

// Blur is a short tween with cubic-bezier(0.33, 0, 0.2, 0.1), independent of
// row movement. Retarget from the displayed radius so an interrupted change
// cannot jump or carry spring velocity into the next focus change.
class BlurValue {
  constructor(value = 0, duration = blurDuration) {
    this.duration = duration;
    this.jump(value);
  }

  jump(value) {
    this.value = value;
    this.from = value;
    this.target = value;
    this.elapsed = this.duration;
  }

  moveTo(value) {
    if (Math.abs(this.target - value) <= 0.01) return;
    this.from = this.value;
    this.target = value;
    this.elapsed = 0;
  }

  retarget(value) {
    this.moveTo(value);
  }

  update(delta) {
    if (this.value === this.target) return;
    this.elapsed += Math.min(Math.max(delta, 0), maxFrameDelta);
    if (this.elapsed >= this.duration) {
      this.value = this.target;
      return;
    }
    const progress = this.elapsed / this.duration;
    // Solve the curve's x coordinate before evaluating y. Treating the
    // elapsed fraction as the curve parameter changes the blur's timing.
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 24; iteration += 1) {
      const t = (low + high) / 2;
      const x = 3 * (1 - t) ** 2 * t * 0.33 + 3 * (1 - t) * t * t * 0.2 + t ** 3;
      if (x < progress) low = t;
      else high = t;
    }
    const t = (low + high) / 2;
    const eased = 3 * (1 - t) * t * t * 0.1 + t ** 3;
    this.value = this.from + (this.target - this.from) * eased;
  }
}

// The soft bright→dim edge is a constant fraction of the
// word's measured height (not a % of its width), so the fade band stays the
// same physical size across every word. JS writes a per-word `--fill` (band
// position in px, measured inside that word's own box); the mask gradient
// itself stays on timed rows during deactivation, while bright and dim alpha
// converge. Removing it at the class change would flash unsung words bright.
const wordFadeWidth = 0.4;

// Keep a separate mask coordinate system for each visual row. A wrapped word
// can contribute glyphs to several rows, so its bounding box alone cannot
// identify either the row widths or the glyph's position within a row.
function measureFillGeometry(lineElement, elements, plans = []) {
  const targets = [...elements];
  for (const plan of plans) {
    for (const char of plan?.chars ?? []) targets.push(char.motion);
  }
  const transforms = targets.map(element => element.style.transform);
  targets.forEach(element => { element.style.transform = ''; });
  try {
    const layoutWidth = Number.parseFloat(getComputedStyle(lineElement).width);
    const scale = layoutWidth > 0 ? lineElement.getBoundingClientRect().width / layoutWidth : 1;
    const widths = [], prefix = [], charLefts = [], charWidths = [];
    const runs = [], wordRuns = [], wordFragments = [], charRuns = [];
    let total = 0;
    let fadeWidth = 1;
    for (let i = 0; i < elements.length; i += 1) {
      const element = elements[i];
      const rtl = element.classList.contains('is-rtl');
      const rects = [...element.getClientRects()].filter(rect => rect.width > 0.01);
      if (!rects.length) rects.push(element.getBoundingClientRect());
      const fragments = [];
      let width = 0;
      prefix.push(total);
      for (const rect of rects) {
        const center = (rect.top + rect.bottom) / 2;
        let runIndex = runs.findIndex(run =>
          Math.abs(run.center - center) < Math.min(run.height, rect.height) * 0.45);
        if (runIndex < 0) {
          runIndex = runs.length;
          runs.push({ center, height: rect.height, start: total + width, total: 0 });
        }
        const run = runs[runIndex];
        const fragmentWidth = Math.max(0.01, rect.width / scale);
        fragments.push({ rect, start: width, runIndex, offset: run.total, width: fragmentWidth });
        run.total += fragmentWidth;
        width += fragmentWidth;
        fadeWidth = Math.max(fadeWidth, rect.height / scale * wordFadeWidth);
      }
      widths.push(width);
      total += width;
      wordRuns.push({ runIndex: fragments[0].runIndex, offset: fragments[0].offset });
      wordFragments.push(fragments.map(fragment => ({
        runIndex: fragment.runIndex,
        offset: fragment.offset,
        width: fragment.width
      })));
      const chars = plans[i]?.chars;
      if (!chars?.length) {
        charLefts.push(null);
        charWidths.push(null);
        charRuns.push(null);
        continue;
      }
      const lefts = [], glyphWidths = [], glyphRuns = [];
      for (const char of chars) {
        const rect = char.motion.getBoundingClientRect();
        const center = (rect.top + rect.bottom) / 2;
        const fragment = fragments.reduce((closest, candidate) =>
          Math.abs((candidate.rect.top + candidate.rect.bottom) / 2 - center) <
          Math.abs((closest.rect.top + closest.rect.bottom) / 2 - center) ? candidate : closest);
        const offset = (rtl ? fragment.rect.right - rect.right : rect.left - fragment.rect.left) / scale;
        lefts.push(fragment.start + offset);
        glyphWidths.push(Math.max(0.01, rect.width / scale));
        glyphRuns.push({ runIndex: fragment.runIndex, offset: fragment.offset + offset });
      }
      charLefts.push(lefts);
      charWidths.push(glyphWidths);
      charRuns.push(glyphRuns);
    }
    return { widths, prefix, total, fadeWidth, charLefts, charWidths, runs, wordRuns, wordFragments, charRuns };
  } finally {
    targets.forEach((element, index) => { element.style.transform = transforms[index]; });
  }
}

// Word lift: as a word starts it rises a few px along Apple Music's
// native spring — sampled from RVA 0x2f4efd as mass 1, stiffness 14, damping 7
// — then holds that lift for the rest of the line. Evaluate the analytical
// spring directly at the frame's exact timestamp instead of stepping through a
// 64-entry (32 FPS) lookup table, so a 2-second rise stays continuous at 60+ Hz.
const wordRisePeak = -3;
const backgroundWordRisePeak = -3;
const wordRiseDurationMs = 2000;
const wordRiseFrequency = Math.sqrt(14);

function springPosition(time, frequency, damping) {
  const omega = Math.sqrt(frequency * frequency - damping * damping);
  const decay = Math.exp(-damping * time);
  return decay * (
    Math.cos(omega * time) + (damping / omega) * Math.sin(omega * time)
  );
}

function wordRiseOffset(elapsedMs) {
  if (elapsedMs <= 0) {
    return 0;
  }
  if (elapsedMs >= wordRiseDurationMs) {
    return wordRisePeak;
  }
  const rise = 1 - springPosition(elapsedMs / 1000, wordRiseFrequency, 3.5);
  return wordRisePeak * rise;
}

// Character motion, ported from Apple Music. A word picks one of three modes
// from its text and its sung duration (`characterMotionMode`, mirroring the
// native draw gate at RVA 0x2f483c and 0x2f662f):
//
//   none      short word -> the whole word takes the 2s spring above
//   rise      CJK, 2+ glyphs -> every glyph springs up on its own clock
//   emphasis  latin, >=1s and <=7 glyphs -> glyphs stagger outward, lift and
//             flash a glow, which is the sustained-note flourish
//
// Emphasis is a unit-mass critically damped spring (native constructor RVA
// the same closed form Apple Music uses so no frame integration is
// needed.
const charFrameCount = 60;

function springProgress(time, response) {
  if (time <= 0) {
    return 0;
  }
  const phase = (2 * Math.PI * time) / Math.max(0.001, response);
  return 1 - (1 + phase) * Math.exp(-phase);
}

const cjkPattern = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
// Matches LyricsBlossom's CJK range check (0x1001b7820): Han + Kana, excluding Hangul
// so space-delimited Korean syllables still group into whole words for emphasis.
const hanKanaPattern = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/;

// Right-to-left scripts: Hebrew through Arabic, plus the presentation forms a
// shaped run is drawn from. A lyric is laid out in the script it is written in
// rather than the app's language, so every line and word decides its own
// direction — a track can mix Arabic verses with an English hook.
const rtlScriptPattern = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
const rtlLetterPattern = /[\u0590-\u08ff]/g;
const latinLetterPattern = /[A-Za-z\u00c0-\u024f]/g;
// Arabic proper, which is the script SF Arabic is drawn for. Hebrew shares the
// right-to-left layout but not this face.
const arabicScriptPattern =
  /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufefc]/;

// The script carrying most of a line's letters decides its direction, so a
// line that opens with "I love you" and turns Arabic is not flipped around one
// word, and a line that quotes a single English word stays right-to-left.
function lyricDirection(text) {
  const value = typeof text === 'string' ? text : '';
  const rtl = value.match(rtlLetterPattern)?.length ?? 0;
  if (rtl === 0) {
    return 'ltr';
  }
  const latin = value.match(latinLetterPattern)?.length ?? 0;
  return rtl >= latin ? 'rtl' : 'ltr';
}

// CJK is animated glyph by glyph with its own spring, so it opts out of the
// emphasis chunks; those exist to bind Latin word fragments back together.
function characterMotionMode(text) {
  if (rtlScriptPattern.test(text)) {
    return 'none';
  }
  const count = Array.from(text.trim()).length;
  if (!count) {
    return 'none';
  }
  if (cjkPattern.test(text)) {
    return count > 1 ? 'rise' : 'none';
  }
  return 'none';
}

// Long words and CJK are allowed to break across rows, which forces them back
// to `display: inline`; everything else is an atomic box so it can carry a
// compositor transform.
function wordAllowsBreak(text) {
  // A cursive word must stay one text run: splitting Arabic or Hebrew into
  // glyph boxes would break its joining forms, so those wrap at spaces only.
  if (rtlScriptPattern.test(text)) {
    return false;
  }
  return text.trim().length >= 16 || cjkPattern.test(text);
}

// Port of chunkAndSplitLyricWords: fragments of the same word are one emphasis
// unit, whole words are not. TTML folds the gap between words into the next
// word's text ("papa", " razzi"), so a leading space is the word boundary —
// "pa" "pa" "razzi" reassemble into one unit, "papa" " razzi" stay two.
// Whitespace-only words and CJK break the run on their own.
function chunkLyricWords(words) {
  const chunks = [];
  let group = [];

  const flush = () => {
    if (group.length > 0) {
      chunks.push(group);
      group = [];
    }
  };

  for (const word of words) {
    const text = word.text ?? '';
    const blank = text.trim().length === 0;
    const cjk = hanKanaPattern.test(text);

    if (blank || cjk || /^\s/.test(text)) {
      flush();
    }
    if (blank || cjk) {
      chunks.push([word]);
      continue;
    }

    group.push(word);
    if (/\s$/.test(text)) {
      flush();
    }
  }
  flush();
  return chunks;
}

function mergeChunk(words) {
  let time = Infinity;
  let end = -Infinity;
  let text = '';
  for (const word of words) {
    time = Math.min(time, word.time);
    end = Math.max(end, word.end);
    text += word.text ?? '';
  }
  return { time, end, text };
}

// A unit is emphasised only when it is at least a second long and short enough
// to read as one accent. One rule for every script: duration >= 1s and a
// trimmed length of 2..7 characters.
function shouldEmphasize(word) {
  const text = (word.text ?? '').trim();
  const durationMs = (word.end - word.time) * 1000;
  if (text.length === 0 || text.length > 7 || durationMs < 1000) {
    return false;
  }
  return durationMs >= 1000 || text.length < 5;
}

export class LyricsView {
  constructor(element, onSeek = null) {
    this.element = element;
    this.track = element.querySelector('.lyrics-track');
    this.onSeek = typeof onSeek === 'function' ? onSeek : null;
    this.hoverIndex = -1;
    this.hoverElement = document.createElement('div');
    this.hoverElement.className = 'lyrics-line-hover';
    this.hoverElement.setAttribute('aria-hidden', 'true');
    this.hoverElement.hidden = true;
    this.readability = new BlurValue(0, hoverTransitionDuration);
    this.interactionRaf = 0;
    this.lastInteractionTime = 0;
    this.pressedIndex = -1;
    this.pressedPointer = null;
    this.cancelledClickIndex = -1;
    this.lines = [];
    this.hasWordTiming = false;
    this.lineElements = [];
    this.wordElements = [];
    this.wordMotions = [];
    this.backgroundWordElements = [];
    this.backgroundWordMotions = [];
    this.backgroundStates = [];
    this.lineStates = [];
    this.interludes = [];
    this.interludeStates = [];
    this.activeIndex = -1;
    this.activeIndices = [];
    this.activeKey = '';
    this.interludeIndex = -1;
    this.anchorIndex = -1;
    this.duration = 0;
    this.playing = false;
    this.lastPosition = null;
    this.lastMotionTime = 0;
    this.effectiveStarts = [];
    this.fillAccelerations = [];
    this.boundaryEnds = [];
    this.sungEnds = [];
    this.focusEnds = [];
    this.fillTails = new Map();
    this.fillGeos = new Map();
    this.backgroundFillGeos = new Map();
    this.metricsGen = 0;
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.interactionEnabled = true;
    this.scrollOffset = 0;
    this.scrollTimer = 0;
    this.accelerateFill = true;
    this.fadeCompleted = false;
    this.lineScale = false;
    this.completedIndices = new Set();
    this.completedFades = new Map();
    this.completedPosition = null;
    this.completedAnchor = -1;
    this.positionRaf = 0;

    element.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'touch') this.setReadability(true);
    });
    element.addEventListener('pointerleave', () => {
      this.setReadability(false);
      this.setLineHover(-1);
      this.releaseLinePress(true);
    });
    window.addEventListener('pointerup', event => this.releaseLinePress(false, event));
    window.addEventListener('pointercancel', event => this.releaseLinePress(true, event));
    window.addEventListener('blur', () => {
      this.setReadability(false);
      this.setLineHover(-1);
      this.releaseLinePress(true);
    });
    this.reduceMotion.addEventListener('change', () => this.stepInteractionMotion(performance.now()));

    element.addEventListener('wheel', (event) => this.onWheel(event), {
      passive: false
    });

    // Line spacing and font metrics change the track height. Observe the
    // track so a CSS/layout change immediately re-anchors the current line.
    this.schedulePositionTrack = () => {
      if (this.positionRaf) return;
      this.positionRaf = requestAnimationFrame(() => {
        this.positionRaf = 0;
        this.positionTrack();
      });
    };
    this.resizeObserver = new ResizeObserver(() => {
      this.metricsGen += 1;
      this.schedulePositionTrack();
    });
    this.resizeObserver.observe(this.track);
    window.addEventListener('resize', () => {
      this.metricsGen += 1;
      this.schedulePositionTrack();
    });
    this.clear();
  }

  setInteractionEnabled(enabled) {
    this.interactionEnabled = enabled;
    if (!enabled) {
      this.releaseLinePress(true, null, true);
      this.setReadability(false, true);
      this.setLineHover(-1, true);
      for (const state of this.lineStates) {
        state.press.jump(1);
        this.renderLinePosition(state);
      }
    }
  }

  setReadability(hovered, immediate = false) {
    this.readability.moveTo(hovered && this.interactionEnabled ? 1 : 0);
    if (immediate || this.reduceMotion.matches) this.readability.jump(this.readability.target);
    // Container hover clears every row together, including the gaps between
    // seek targets. Its short blur tween stays independent of text opacity.
    for (const state of this.lineStates) {
      state.hoverBlur.moveTo(this.readability.target);
      if (immediate || this.reduceMotion.matches) state.hoverBlur.jump(state.hoverBlur.target);
    }
    this.scheduleInteractionMotion();
  }

  canHoverLine(index) {
    const row = this.lineElements[index];
    return this.interactionEnabled && Boolean(row) &&
      !(this.fadeCompleted && row.classList.contains('is-completed') &&
        !this.element.classList.contains('is-scrolling'));
  }

  canSeekLine(index) {
    const line = this.lines[index];
    return this.canHoverLine(index) && this.onSeek && !line.isCredit && Number.isFinite(line.time);
  }

  setLineHover(index, immediate = false) {
    this.hoverIndex = this.canHoverLine(index) ? index : -1;
    for (let i = 0; i < this.lineStates.length; i += 1) {
      const state = this.lineStates[i];
      const hovered = i === this.hoverIndex;
      const showPlate = hovered && Boolean(this.canSeekLine(i));
      state.element.classList.toggle('is-hovered', hovered);
      state.hover.moveTo(showPlate ? 1 : 0);
      if (immediate || this.reduceMotion.matches) {
        state.hover.jump(state.hover.target);
      }
      state.hoverPlate.classList.toggle('is-visible', showPlate);
    }
    if (this.hoverIndex >= 0) {
      this.hoverElement = this.lineStates[this.hoverIndex].hoverPlate;
      this.measureLineHover();
    }
    this.scheduleInteractionMotion();
  }

  pressLine(index, event) {
    if (event.button !== 0 || event.isPrimary === false || !this.canSeekLine(index)) return;
    this.releaseLinePress(true);
    this.cancelledClickIndex = -1;
    this.pressedIndex = index;
    this.pressedPointer = event.pointerId;
    this.pressedPointerType = event.pointerType;
    this.setLineHover(index);
    const spring = this.lineStates[index].press;
    spring.configure(pressSpring.stiffness, pressSpring.damping, pressSpring.mass);
    spring.moveTo(0.95);
    if (this.reduceMotion.matches) spring.jump(1);
    this.scheduleInteractionMotion();
  }

  releaseLinePress(cancelled = false, event = null, immediate = false) {
    if (this.pressedIndex < 0 || (event && event.pointerId !== this.pressedPointer)) return;
    const index = this.pressedIndex;
    this.pressedIndex = -1;
    this.pressedPointer = null;
    if (cancelled) this.cancelledClickIndex = index;
    const spring = this.lineStates[index]?.press;
    if (spring) {
      spring.configure(releaseSpring.stiffness, releaseSpring.damping, releaseSpring.mass);
      spring.moveTo(1);
      if (immediate || this.reduceMotion.matches) spring.jump(1);
    }
    if (this.pressedPointerType === 'touch') this.setLineHover(-1, immediate);
    this.scheduleInteractionMotion();
  }

  scheduleInteractionMotion() {
    if (this.interactionRaf) return;
    this.lastInteractionTime = performance.now();
    this.interactionRaf = requestAnimationFrame(now => this.stepInteractionMotion(now));
  }

  stepInteractionMotion(now) {
    cancelAnimationFrame(this.interactionRaf);
    this.interactionRaf = 0;
    const delta = Math.max(0, (now - this.lastInteractionTime) / 1000);
    this.lastInteractionTime = now;
    const springs = [this.readability];
    for (const state of this.lineStates) springs.push(state.hover, state.hoverBlur, state.press);
    let moving = false;
    for (const spring of springs) {
      if (this.reduceMotion.matches) spring.jump(spring === this.lineStates[this.pressedIndex]?.press ? 1 : spring.target);
      else spring.update(delta);
      moving ||= spring.value !== spring.target || Boolean(spring.velocity);
    }
    // Only pointer effects advance here. Playback, word fill and row stagger
    // keep their existing clock and cannot run twice in the same frame.
    for (const state of this.lineStates) this.renderLinePosition(state);
    if (moving) this.interactionRaf = requestAnimationFrame(time => this.stepInteractionMotion(time));
  }

  measureLineHover() {
    for (const state of this.lineStates) {
      const row = state.element;
      const plate = state.hoverPlate;
      // The highlight is a sibling of the text, so inactive opacity and blur
      // cannot dim or smear it. Copy layout dimensions without adding padding to
      // the lyric itself, which would otherwise change wrapping and scroll aims.
      const style = getComputedStyle(row);
      Object.assign(plate.style, {
        top: `${row.offsetTop}px`, left: `${row.offsetLeft}px`,
        width: `${row.offsetWidth}px`, height: `${row.offsetHeight}px`,
        fontSize: style.fontSize, transformOrigin: style.transformOrigin
      });
    }
  }

  renderLineHover(state) {
    const plate = state.hoverPlate;
    plate.hidden = state.hover.value <= 0.001 && state.hover.target === 0;
    const opacity = String(clamp01(state.hover.value));
    if (plate.style.opacity !== opacity) plate.style.opacity = opacity;
    if (plate.style.transform !== state.element.style.transform) {
      plate.style.transform = state.element.style.transform;
    }
  }

  clear() {
    this.releaseLinePress(true, null, true);
    this.setReadability(false, true);
    this.setLineHover(-1, true);
    cancelAnimationFrame(this.interactionRaf);
    this.interactionRaf = 0;
    this.cancelledClickIndex = -1;
    this.completedIndices.clear();
    this.completedFades.clear();
    this.completedPosition = null;
    this.completedAnchor = -1;
    clearTimeout(this.scrollTimer);
    this.scrollTimer = 0;
    this.scrollOffset = 0;
    this.element.classList.remove('is-scrolling');
    this.lines = [];
    this.hasWordTiming = false;
    this.lineElements = [];
    this.wordElements = [];
    this.wordMotions = [];
    this.backgroundWordElements = [];
    this.backgroundWordMotions = [];
    this.backgroundStates = [];
    this.lineStates = [];
    this.interludes = [];
    this.interludeStates = [];
    this.activeIndex = -1;
    this.activeIndices = [];
    this.activeKey = '';
    this.interludeIndex = -1;
    this.anchorIndex = -1;
    this.duration = 0;
    this.lastPosition = null;
    this.lastMotionTime = 0;
    this.effectiveStarts = [];
    this.fillAccelerations = [];
    this.boundaryEnds = [];
    this.sungEnds = [];
    this.focusEnds = [];
    this.fillTails.clear();
    this.fillGeos.clear();
    this.backgroundFillGeos.clear();
    this.track.replaceChildren(this.hoverElement);
    this.element.classList.remove('is-playing');
    this.element.classList.add('is-empty');
  }

  // Rebuild both clocks together so an accelerated fill hands focus to the
  // next row when its sweep finishes, without waiting for the original end.
  rebuildTimeline() {
    this.timelineReducedMotion = this.reduceMotion.matches;
    this.boundaryEnds = boundaryEndsFor(this.lines);
    this.sungEnds = sungEndsFor(this.lines, this.boundaryEnds);
    this.effectiveStarts = effectiveStartsFor(this.lines);
    this.fillAccelerations = this.lines.map((line, index) => {
      if (!this.accelerateFill || this.timelineReducedMotion || !line.words?.length) return null;
      const window = this.fillAccelerationWindowFor(index, line.words);
      if (!window || lineFillDone(line, 0) <= window.start ||
          window.end >= (this.lines[index + 1]?.time ?? Infinity)) return null;
      return window;
    });
    for (let index = 0; index < this.fillAccelerations.length; index += 1) {
      const window = this.fillAccelerations[index];
      if (window) this.effectiveStarts[index + 1] = window.end;
    }
    this.focusEnds = focusEndsFor(this.lines, this.boundaryEnds, this.effectiveStarts);
  }

  setAccelerateFill(enabled) {
    this.accelerateFill = Boolean(enabled);
    this.rebuildTimeline();
    this.completedPosition = null;
    this.update(this.lastPosition ?? 0, this.duration, this.playing);
  }

  setFadeCompleted(enabled) {
    this.fadeCompleted = Boolean(enabled);
    this.element.classList.toggle('is-fade-completed', this.fadeCompleted);
    this.completedPosition = null;
    this.syncCompletedLines(this.lastPosition ?? 0);
  }

  targetScaleForLine(index) {
    if (!this.lineScale || this.reduceMotion.matches || this.lines[index]?.isCredit) {
      return 1;
    }
    const isActive = this.lineElements[index]?.classList.contains('is-active');
    if (this.lines[index]?.isBackground) {
      return isActive ? 0.7 : 0.63;
    }
    return isActive ? 1 : 0.98;
  }

  targetOpacityForLine(index) {
    const line = this.lines[index];
    const isActive = Boolean(this.lineElements[index]?.classList.contains('is-active'));
    if (this.element.classList.contains('is-scrolling')) {
      return isActive ? 0.85 : 0.5;
    }
    if (line?.isBackground) {
      return isActive ? 0.3 : 0.175;
    }
    if (line?.isCredit) {
      return isActive ? 0.85 : 0.55;
    }
    // Completed lines fade via --completed-opacity on .lyrics-line; holding
    // --line-opacity at 0.85 avoids a simultaneous fast drop to 0.175.
    if (this.fadeCompleted && this.completedIndices.has(index)) {
      return 0.85;
    }
    return isActive ? 0.85 : 0.175;
  }

  targetWordOpacityForLine(index) {
    const opacity = this.targetOpacityForLine(index);
    return this.lines[index]?.words?.length &&
      this.lineElements[index]?.classList.contains('is-active')
      ? Math.min(opacity, 0.3)
      : opacity;
  }

  targetBlurForLine(index) {
    if (this.element.classList.contains('is-scrolling')) {
      return 0;
    }
    return this.targetBlurs?.[index] ?? 0;
  }

  dynamicLineSpring(activeIndex = this.anchorIndex, interludeIndex = this.interludeIndex, seek = false) {
    if (seek || interludeIndex >= 0 || !this.hasWordTiming) {
      return seekSpring;
    }
    const current = this.lines[activeIndex];
    const previous = this.lines[activeIndex - 1];
    const prevEnd = previous
      ? (lineEndTime(previous, this.sungEnds[activeIndex - 1]) ?? previous.time)
      : null;
    const interval = current && Number.isFinite(prevEnd)
      ? (current.time - prevEnd) * 1000
      : 0;
    return lineSpringParams(interval);
  }

  syncLineScales(instant = false) {
    const params = this.dynamicLineSpring();
    for (let index = 0; index < this.lineStates.length; index += 1) {
      const state = this.lineStates[index];
      const target = this.targetScaleForLine(index);
      if (instant) {
        state.scale.configure(params.stiffness, params.damping, params.mass);
        state.scale.jump(target);
        continue;
      }
      const pendingTarget = state.scale.queuedTarget ?? state.scale.target;
      if (Math.abs(pendingTarget - target) <= 0.01) {
        continue;
      }
      const scaleParams = this.lines[index]?.isBackground
        ? (this.lineElements[index]?.classList.contains('is-active')
            ? activeScaleSpring
            : inactiveScaleSpring)
        : params;
      state.scale.configure(scaleParams.stiffness, scaleParams.damping, scaleParams.mass);
      state.scale.moveTo(target);
    }
  }

  setLineScale(enabled) {
    this.lineScale = Boolean(enabled);
    this.element.classList.toggle('is-line-scale', this.lineScale);
    this.syncLineScales(this.reduceMotion.matches);
    this.stepMotion(performance.now(), true);
  }

  syncCompletedLines(position, animate = true) {
    if (!this.fadeCompleted && this.completedIndices.size === 0) return;
    if (position === this.completedPosition && this.anchorIndex === this.completedAnchor) return;
    this.completedPosition = position;
    this.completedAnchor = this.anchorIndex;
    for (let index = 0; index < this.lines.length; index += 1) {
      // Keep overlapping vocals and backing tails visible until their audio
      // ends. Credits and the current scroll anchor are never hidden.
      const finishAt = Math.max(this.sungEnds[index], this.fillTails.get(index) ?? 0);
      const completed = this.fadeCompleted && !this.lines[index].isCredit &&
        index < this.anchorIndex && position >= finishAt;
      if (completed === this.completedIndices.has(index)) continue;
      const element = this.lineElements[index];
      if (completed) {
        const from = animate ? Number(getComputedStyle(element).opacity) : 0;
        element.style.setProperty('--completed-opacity', String(from));
        if (from > 0) {
          this.completedFades.set(index, { from, opacity: from, startY: null, targetY: null, progress: 0 });
          this.bindCompletedFade(index);
        }
      } else {
        this.completedFades.delete(index);
        element.style.removeProperty('--completed-opacity');
      }
      element.classList.toggle('is-completed', completed);
      if (completed) {
        this.completedIndices.add(index);
        element.classList.remove('is-hovered');
        if (index === this.hoverIndex) this.setLineHover(-1, true);
      } else {
        this.completedIndices.delete(index);
      }
    }
  }

  bindCompletedFade(index) {
    const fade = this.completedFades.get(index);
    if (!fade) return;
    const spring = this.lineStates[index].y;
    const target = spring.queuedTarget ?? spring.target;
    if (fade.targetY === target) return;
    // Re-layout and retargeting preserve the opacity already on screen, then
    // map the remaining fade onto this row's remaining spring displacement.
    fade.from = fade.opacity;
    fade.startY = spring.value;
    fade.targetY = target;
    fade.progress = 0;
  }

  stepCompletedFades() {
    for (const [index, fade] of this.completedFades) {
      const spring = this.lineStates[index].y;
      const distance = fade.targetY - fade.startY;
      const progress = Math.abs(distance) < 0.001 ? 1
        : clamp01((spring.value - fade.startY) / distance);
      // A spring's overshoot must not bring a vanished line back on rebound.
      fade.progress = Math.max(fade.progress, progress);
      fade.opacity = fade.from * (1 - fade.progress);
      this.lineElements[index].style.setProperty('--completed-opacity', fade.opacity.toFixed(4));
      if (fade.progress === 1) this.completedFades.delete(index);
    }
  }

  // Text metrics changed (font family, weight or size). Fill geometry is keyed
  // on a line's box width, and a font swap keeps that width while changing
  // every word in it, so the cache has to be dropped explicitly. The next
  // frame measures again; the tracked row height re-anchors via the observer.
  refreshMetrics() {
    this.metricsGen += 1;
    this.fillGeos.clear();
    this.backgroundFillGeos.clear();
    for (const row of this.wordElements) {
      for (const element of row) element.__fill = undefined;
    }
    for (const row of this.backgroundWordElements) {
      for (const element of row) element.__fill = undefined;
    }
    for (const row of [...this.wordMotions, ...this.backgroundWordMotions]) {
      for (const plan of row) {
        for (const char of plan?.chars ?? []) char.lastFill = Number.NaN;
      }
    }
    this.positionTrack();
  }

  interludeAt(position) {
    for (let index = 0; index < this.interludes.length; index += 1) {
      const interlude = this.interludes[index];
      if (position >= interlude.start && position < interlude.end) {
        return index;
      }
    }
    return -1;
  }

  hideInterlude(interlude, position) {
    interlude.active = false;
    interlude.anchor = null;
    interlude.lastPosition = position;
    setStyleIfChanged(interlude.group, 'opacity', '0');
    setStyleIfChanged(interlude.group, 'transform', 'scale(0)');
    for (const dot of interlude.dots) {
      setStyleIfChanged(dot, 'opacity', '0');
    }
  }

  shiftLinesFrom(index, delta) {
    for (
      let lineIndex = index;
      lineIndex < this.lineStates.length;
      lineIndex += 1
    ) {
      const y = this.lineStates[lineIndex].y;
      y.shiftBy(delta);
    }
  }

  setInterludeActive(index, active) {
    if (index < 0 || index >= this.interludes.length) {
      return;
    }

    const interlude = this.interludes[index];
    const element = interlude.element;
    const wasActive = element.classList.contains('is-active');
    if (wasActive === active) {
      return;
    }

    // Adding/removing the dots row also adds/removes a flex gap. Compensate
    // the full layout change so the existing springs move following lines
    // smoothly instead of letting that gap jump them by one row spacing.
    const nextLine = this.lineElements[interlude.before];
    const previousTop = nextLine?.offsetTop ?? 0;
    element.classList.toggle('is-active', active);
    if (nextLine) {
      this.shiftLinesFrom(interlude.before, previousTop - nextLine.offsetTop);
    }
  }

  updateInterludeDots(position) {
    for (let index = 0; index < this.interludes.length; index += 1) {
      const interlude = this.interludes[index];
      if (
        index !== this.interludeIndex ||
        position < interlude.start ||
        position >= interlude.end
      ) {
        this.hideInterlude(interlude, position);
        continue;
      }

      const wasActive = interlude.active === true;
      const lastPosition = interlude.lastPosition;
      interlude.active = true;

      const seek =
        lastPosition !== undefined &&
        Math.abs(position - lastPosition) > 0.6;
      if (!wasActive || interlude.anchor === null || seek) {
        interlude.anchor = position;
      }
      interlude.lastPosition = position;

      const anchor = interlude.anchor;
      const duration = interlude.end - anchor;
      const elapsed = position - anchor;
      if (elapsed > duration) {
        this.hideInterlude(interlude, position);
        continue;
      }

      const breatheDuration =
        duration / Math.max(1, Math.ceil(duration / 4.5));
      let scale =
        Math.sin(1.5 * Math.PI - (elapsed / breatheDuration) * 2 * Math.PI) /
          20 +
        1;
      let opacity = 1;

      if (elapsed < 2) {
        scale *= easeOutExpo(elapsed / 2);
      }
      if (elapsed < 0.5) {
        opacity = 0;
      } else if (elapsed < 1) {
        opacity *= (elapsed - 0.5) / 0.5;
      }

      const remaining = duration - elapsed;
      if (remaining < 0.75) {
        scale *= 1 - easeInOutBack((0.75 - remaining) / 0.75 / 2);
      }
      if (remaining < 0.375) {
        opacity *= clamp01(remaining / 0.375);
      }

      const dotsDuration = Math.max(0, duration - 0.75);
      scale = Math.max(0, scale) * 0.95;
      setStyleIfChanged(
        interlude.group,
        'transform',
        `scale(${scale.toFixed(4)})`
      );
      setStyleIfChanged(
        interlude.group,
        'opacity',
        opacity.toFixed(3)
      );

      for (let dotIndex = 0; dotIndex < interlude.dots.length; dotIndex += 1) {
        const fraction = dotsDuration > 0
          ? ((elapsed - (dotsDuration / 3) * dotIndex) * 3) /
            dotsDuration *
            0.75
          : 0.25;
        const dotOpacity = dotsDuration > 0
          ? Math.min(1, Math.max(0.25, fraction))
          : 0.25;
        setStyleIfChanged(
          interlude.dots[dotIndex],
          'opacity',
          clamp01(opacity * dotOpacity).toFixed(3)
        );
      }
    }
  }

  // Builds one karaoke word and its motion plan. Words taking character motion
  // (or needing to break across rows) get each glyph wrapped in a
  // `.lyrics-char-motion` box with whitespace left as a bare text node — the
  // same markup Apple Music uses, which is what keeps the text metrics and the
  // wrapping identical to plain text. Everything else stays a single text node.
  //
  // `chunk` is the emphasis unit this word belongs to. When the unit is
  // emphasised every word in it shares one set of animation parameters and one
  // continuous character stagger, so the phrase moves as a single gesture.
  createWord(word, chunk = null) {
    const element = document.createElement('span');
    element.className = 'lyrics-word';
    const text = word.text ?? '';
    // The karaoke band is measured from the word's own start, which is its
    // right edge for an RTL word — even when that word sits inside an English
    // line — so the mask has to sweep from that side.
    if (rtlScriptPattern.test(text)) {
      element.classList.add('is-rtl');
    }
    const durationMs = Math.max(0, (word.end - word.time) * 1000);
    const mode = chunk?.simpleMotion ? 'none' : characterMotionMode(text);
    const cjk = mode === 'rise';
    const emphasize = Boolean(chunk?.emphasize);
    const allowBreak = wordAllowsBreak(text);
    const plan = {
      element,
      mode,
      start: word.time,
      chars: null,
      targets: [element],
      params: null,
      last: Number.NaN
    };

    if (!emphasize && mode === 'none' && !allowBreak) {
      element.textContent = text;
      return plan;
    }

    if (allowBreak) {
      element.classList.add('allow-break');
    }
    element.classList.add('has-chars');

    const count = Array.from(text).filter((char) => !/\s/.test(char)).length;
    const duration = durationMs / 1000;
    let delayBase = 0;
    let delayStep = 0;

    if (emphasize && chunk?.params) {
      // One cascade for the whole unit: every character is offset from the
      // unit's own start, de + du / 2.5 / anchorCharCount * i.
      plan.params = chunk.params;
      delayBase = (chunk.start - word.time) * 1000;
      delayStep = chunk.staggerMs;
    } else if (mode !== 'none' && count > 0) {
      // A lone CJK word keeps its own spring and its own stagger.
      const staggerMs = (durationMs / count) * (cjk ? 0.4 : 0.35);
      delayStep = cjk
        ? Math.min(staggerMs, 50, 200 / count)
        : Math.min(staggerMs, 350);
      delayBase = delayStep;
      const hold = (2 * duration) / count;
      const response = Math.min(3, duration);
      const spanDuration = Math.max(hold + response * 2, cjk ? 3 : 0);
      if (spanDuration > 0) {
        plan.params = {
          cjk,
          emphasis: 0,
          glow: 0,
          spanDuration,
          hold,
          response,
          response2: Math.max(1.25 * response, 0.001)
        };
      }
    }
    plan.chars = [];

    const charOffset = chunk?.charOffset ?? 0;
    const charTotal = chunk?.charTotal || count;
    let index = 0;
    for (const char of Array.from(text)) {
      if (/\s/.test(char)) {
        element.append(document.createTextNode(char));
        continue;
      }
      const motion = document.createElement('span');
      motion.className = 'lyrics-char-motion';
      const glyph = document.createElement('span');
      glyph.className = 'lyrics-char';
      glyph.textContent = char;
      motion.append(glyph);
      const charIndex = charOffset + index;
      let glowElement = null;
      if (plan.params && plan.params.glow > 0) {
        glowElement = document.createElement('span');
        glowElement.className = 'lyrics-char-glow';
        glowElement.setAttribute('aria-hidden', 'true');
        // The glyph is drawn by `::before { content: attr(data-glyph) }`, so the
        // glow never adds a second copy of the text to the DOM: `textContent`
        // and text selection stay exactly the lyric.
        glowElement.dataset.glyph = char;
        motion.append(glowElement);
      }
      element.append(motion);
      plan.chars.push({
        motion,
        glyph,
        glow: glowElement,
        offset: (charIndex - (charTotal - 1) / 2) * 0.5,
        delayMs: plan.params
          ? delayBase + (emphasize ? charIndex + 1 : charIndex) * delayStep
          : 0,
        lastTransform: '',
        lastOpacity: Number.NaN
      });
      index += 1;
    }

    // Breaking words stay `display: inline` so the row can wrap, which means
    // the whole-word spring has to be applied per glyph box instead.
    if (allowBreak && mode === 'none') {
      plan.targets = plan.chars.map((char) => char.motion);
    }
    return plan;
  }

  // One emphasis unit: adjacent words that share a single character cascade.
  // Bind timed syllables into a single wrapping unit without merging their clocks.
  buildChunk(words, { simpleMotion = false } = {}) {
    const merged = mergeChunk(words);
    const cjk = cjkPattern.test(merged.text);
    let charTotal = 0;
    for (const word of words) {
      charTotal += Array.from(word.text ?? '')
        .filter((char) => !/\s/.test(char)).length;
    }
    // Judge the reassembled word, never its fragments: "super" + "powers" is
    // ten characters, so it must not emphasise just because each half fits.
    // The character flourish is a Latin gesture anyway: splitting a cursive
    // word into glyph boxes would break its joins and reverse its letters.
    const emphasize = !simpleMotion && !rtlScriptPattern.test(merged.text) &&
      shouldEmphasize(merged);

    let params = null;
    let staggerMs = 0;

    if (emphasize) {
      const anchor = Math.max(1, charTotal);
      const duration = Math.max(0, merged.end - merged.time);
      const response = Math.min(3, Math.max(0.001, duration));
      const staggerCap = cjk ? 0.8 : 0.4;
      const perCharDelay = Math.min(staggerCap, (staggerCap * duration) / anchor);
      const hold = (2 * duration) / anchor;
      const ramp = Math.min(2, Math.max(1, duration)) - 1;
      params = {
        cjk,
        emphasis: 1,
        start: merged.time,
        scaleDelta: 0.14 * ramp,
        liftExtra: 1.5 * ramp,
        glow: 0.7 * (Math.min(1.5, Math.max(1, duration)) - 1),
        glowOff: perCharDelay * anchor + hold,
        spanDuration: Math.max(hold + response * 2, cjk ? 2.5 : 0),
        hold,
        response,
        response2: response
      };
      staggerMs = perCharDelay * 1000;
    }

    const wrapper = document.createElement('span');
    wrapper.className = 'lyrics-emphasis';
    if (!wordAllowsBreak(merged.text)) {
      wrapper.classList.add('is-unbreakable');
    }
    const plans = [];
    let charOffset = 0;
    for (const word of words) {
      const plan = this.createWord(word, {
        simpleMotion,
        emphasize,
        params,
        staggerMs,
        charOffset,
        charTotal,
        start: merged.time
      });
      wrapper.append(plan.element);
      plans.push(plan);
      charOffset += Array.from(word.text ?? '')
        .filter((char) => !/\s/.test(char)).length;
    }

    return { wrapper, plans };
  }

  setLyrics(lines, position = 0, duration = 0, playing = this.playing) {
    this.clear();
    const normalizedInput = Array.isArray(lines) ? lines.map((line) => {
      if (!line || !Array.isArray(line.words) || line.words.length === 0) {
        return line;
      }
      const needsSpaces =
        line.words.length > 1 &&
        typeof line.text === 'string' &&
        line.words.every((w) => typeof w?.text === 'string' && !/\s/.test(w.text)) &&
        line.text.trim() === line.words.map((w) => w.text).join(' ');
      const needsStart = line.words.some(
        (w) => !Number.isFinite(w?.time) && Number.isFinite(w?.start)
      );
      const words = needsSpaces || needsStart
        ? line.words.map((word, idx) => ({
            ...word,
            time: Number.isFinite(word.time) ? word.time : word.start,
            text: needsSpaces && idx < line.words.length - 1 ? `${word.text} ` : word.text
          }))
        : line.words;
      const time = Number.isFinite(line.time) ? line.time : words[0]?.time ?? 0;
      const end = Number.isFinite(line.end)
        ? line.end
        : words[words.length - 1]?.end ?? time;
      return words !== line.words || time !== line.time || end !== line.end
        ? { ...line, time, end, words }
        : line;
    }) : [];
    if (lines?.credits) normalizedInput.credits = lines.credits;
    this.lines = groupBackgroundLines(normalizedInput);
    this.hasWordTiming = this.lines.some(line => !line.isCredit && line.words?.length > 0);
    if (this.lines.length && lines.credits) {
      const time = Math.max(...this.lines.map(line =>
        Number.isFinite(line.end) ? line.end : line.time + 5
      )) + 0.001;
      for (const [label, names] of [
        ['Written by:', lines.credits.writers], ['Synced by:', lines.credits.syncers]
      ]) {
        if (names?.length) this.lines.push({
          time, text: names.join(', '), creditLabel: label, isCredit: true
        });
      }
    }
    this.duration = duration;
    this.playing = Boolean(playing);
    this.element.classList.toggle('is-playing', this.playing);
    if (this.lines.length === 0) {
      return;
    }

    const gaps = findInterludeGaps(this.lines);
    const gapByBefore = new Map();
    for (const gap of gaps) {
      gapByBefore.set(gap.before, gap);
    }

    const fragment = document.createDocumentFragment();
    this.wordMotions = [];
    for (let index = 0; index < this.lines.length; index += 1) {
      const gap = gapByBefore.get(index);
      if (gap) {
        const interlude = createInterludeElement();
        fragment.append(interlude.element);
        this.interludes.push({
          ...gap,
          ...interlude,
          active: false,
          anchor: null,
          lastPosition: undefined
        });
      }
      const line = this.lines[index];
      const motions = [];
      const element = document.createElement('p');
      element.className = 'lyrics-line is-far';
      // The row follows its own script, not the app's language: Arabic and
      // Hebrew lines read from the right, and an Arabic line takes SF Arabic
      // for its Arabic runs. Credits are labels, not sung text, so they keep
      // the app's direction.
      if (!line.isCredit) {
        const script = [line.text, line.backgroundText]
          .filter(Boolean)
          .join(' ');
        if (lyricDirection(script) === 'rtl') {
          element.dir = 'rtl';
        }
        if (arabicScriptPattern.test(script)) {
          element.classList.add('is-arabic');
        }
      }
      const main = document.createElement('span');
      main.className = 'lyrics-main-text';
      element.append(main);
      if (line.isBackground) {
        element.classList.add('is-background');
      }
      element.addEventListener('click', event => {
        if (this.cancelledClickIndex === index && event.detail !== 0) {
          this.cancelledClickIndex = -1;
          return;
        }
        if (this.canSeekLine(index)) {
          this.endManualScroll();
          this.onSeek(line.time);
        }
      });
      element.addEventListener('pointerenter', event => {
        if (event.pointerType === 'touch') return;
        this.setReadability(true);
        this.setLineHover(index);
      });
      element.addEventListener('pointerleave', () => {
        if (this.hoverIndex === index) this.setLineHover(-1);
        if (this.pressedIndex === index) this.releaseLinePress(true);
      });
      element.addEventListener('pointerdown', event => this.pressLine(index, event));
      element.addEventListener('pointercancel', event => {
        this.releaseLinePress(true, event);
        if (this.hoverIndex === index) this.setLineHover(-1);
      });
      if (line.isCredit) {
        element.classList.add('is-credit');
        const label = document.createElement('strong');
        label.textContent = line.creditLabel;
        main.append(label, document.createTextNode(` ${line.text}`));
      } else if (line.words?.length) {
        element.classList.add('has-words');
        const chunks = chunkLyricWords(line.words);
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
          const built = this.buildChunk(chunks[chunkIndex]);
          main.append(built.wrapper);
          motions.push(...built.plans);
        }
      } else if (line.isBackground && line.backgroundWords?.length) {
        for (const chunk of chunkLyricWords(line.backgroundWords)) {
          const built = this.buildChunk(chunk, { simpleMotion: true });
          main.append(built.wrapper);
          for (const plan of built.plans) plan.element.classList.add('lyrics-background-word');
          motions.push(...built.plans);
        }
      } else {
        main.textContent = line.text;
      }
      const backgroundWordElements = [];
      const backgroundMotions = [];
      if (!line.isBackground &&
          (line.backgroundText || line.backgroundWords?.length)) {
        const backgroundSlot = document.createElement('span');
        backgroundSlot.className = 'lyrics-background-slot';
        const background = document.createElement('span');
        background.className = 'lyrics-background-text';
        const backgroundInner = document.createElement('span');
        backgroundInner.className = 'lyrics-background-inner';
        if (line.backgroundWords?.length) {
          background.classList.add('has-background-words');
          for (const chunk of chunkLyricWords(line.backgroundWords)) {
            // Backing words keep timed fill and a small lift, without the
            // lead vocal's character cascade, scale pulse or glow.
            const built = this.buildChunk(chunk, { simpleMotion: true });
            backgroundInner.append(built.wrapper);
            for (const plan of built.plans) {
              plan.element.classList.add('lyrics-background-word');
              backgroundWordElements.push(plan.element);
              backgroundMotions.push(plan);
            }
          }
        } else {
          backgroundInner.textContent = line.backgroundText ?? '';
        }
        background.append(backgroundInner);
        backgroundSlot.append(background);
        if (line.backgroundBefore) {
          background.classList.add('is-before');
          element.insertBefore(backgroundSlot, main);
        } else {
          element.append(backgroundSlot);
        }
        element.classList.add('has-background');
      }
      fragment.append(element);
      this.wordMotions.push(motions);
      this.backgroundWordMotions.push(backgroundMotions);
      if (line.isBackground) {
        this.backgroundWordElements.push(
          Array.from(element.querySelectorAll('.lyrics-background-word'))
        );
      } else {
        this.backgroundWordElements.push(backgroundWordElements);
      }
    }
    this.track.append(fragment);

    this.lineElements = Array.from(
      this.track.querySelectorAll('.lyrics-line')
    );
    this.wordElements = this.lineElements.map((element) =>
      Array.from(element.querySelectorAll('.lyrics-main-text .lyrics-word'))
    );
    this.backgroundStates = this.lineElements.map((element, index) => {
      const background = element.querySelector('.lyrics-background-text');
      if (!background) {
        return null;
      }
      const inner = background.querySelector('.lyrics-background-inner');
      const slot = background.parentElement;
      return {
        index,
        element: background,
        inner,
        slot,
        layoutHeight: 0,
        layoutDirty: false,
        lastLayoutHeight: Number.NaN,
        slide: new SpringValue(0),
        opacity: new SpringValue(0),
        hiddenTarget: background.classList.contains('is-before') ? 80 : -80,
        isBefore: background.classList.contains('is-before'),
        isActive: false,
        height: inner ? Number.parseFloat(getComputedStyle(inner).height) || 0 : 0,
        lastSlide: Number.NaN,
        lastHidden: null
      };
    });
    this.element.classList.remove('is-empty');
    this.rebuildTimeline();
    this.applyDuetAlignment();
    this.interludeIndex = this.interludeAt(position);
    this.activeIndices = this.interludeIndex >= 0
      ? []
      : activeIndicesAt(this.effectiveStarts, this.focusEnds, position);
    this.activeIndex = this.activeIndices.length
      ? this.activeIndices[this.activeIndices.length - 1]
      : -1;
    this.activeKey = this.activeIndices.join(',');
    this.anchorIndex = this.activeIndices.length
      ? primaryLyricIndex(this.lines, this.activeIndices, position)
      : this.interludeIndex >= 0
        ? Math.max(0, this.interludes[this.interludeIndex].before - 1)
        : 0;
    this.applyClasses(this.activeIndices);
    this.setInterludeActive(this.interludeIndex, true);

    this.lineStates = this.lineElements.map((element, index) => {
      const hoverPlate = index === 0 ? this.hoverElement : this.hoverElement.cloneNode(false);
      hoverPlate.classList.remove('is-visible');
      hoverPlate.hidden = true;
      hoverPlate.style.opacity = '0';
      this.track.prepend(hoverPlate);
      return {
        element,
        y: new SpringValue(0),
        scale: new SpringValue(1, 0.0001),
        opacity: new SpringValue(0.175, 0.0001),
        wordOpacity: new SpringValue(0.175, 0.0001),
        opacityFrom: 0.175,
        wordOpacityFrom: 0.175,
        blur: new BlurValue(0),
        hover: new PointerSpring(0),
        hoverBlur: new BlurValue(0, hoverTransitionDuration),
        press: new PointerSpring(1),
        hoverPlate,
        backgroundTargetHeight: 0,
        backgroundOffset: 0,
        lastY: Number.NaN,
        lastScale: Number.NaN,
        lastOpacity: Number.NaN,
        lastDarkAlpha: Number.NaN,
        lastBlur: Number.NaN
      };
    });
    for (const state of this.lineStates) {
      for (const alpha of [state.opacity, state.wordOpacity]) {
        alpha.configure(opacitySpring.stiffness, opacitySpring.damping, opacitySpring.mass);
      }
    }
    this.interludeStates = this.interludes.map(({ element }) => {
      return {
        element,
        y: new SpringValue(0),
        backgroundTargetHeight: 0,
        backgroundOffset: 0,
        lastY: Number.NaN
      };
    });

    this.lastPosition = position;
    this.lastMotionTime = performance.now();
    for (let index = 0; index < this.backgroundStates.length; index += 1) {
      const state = this.backgroundStates[index];
      if (!state) {
        continue;
      }
      state.slide.configure(
        activeScaleSpring.stiffness,
        activeScaleSpring.damping,
        activeScaleSpring.mass
      );
      const active = index === this.anchorIndex && this.activeIndices.includes(index);
      state.isActive = active;
      state.element.classList.toggle('is-background-active', active);
      state.slide.jump(active ? 0 : state.hiddenTarget);
      state.opacity.configure(activeScaleSpring.stiffness, activeScaleSpring.damping, activeScaleSpring.mass);
      state.opacity.jump(active ? 0.3 : 0);
      this.renderBackgroundState(state, true);
    }
    this.updateTargets(this.anchorIndex, {
      initial: true,
      interlude: this.interludeIndex
    });
    for (const state of this.lineStates) {
      state.y.jump(state.y.target);
    }
    for (const state of this.interludeStates) {
      state.y.jump(state.y.target);
    }
    this.syncLineScales(true);
    for (let index = 0; index < this.lineStates.length; index += 1) {
      this.lineStates[index].opacity.jump(this.targetOpacityForLine(index));
      this.lineStates[index].opacityFrom = this.targetOpacityForLine(index);
      this.lineStates[index].wordOpacity.jump(this.targetWordOpacityForLine(index));
      this.lineStates[index].wordOpacityFrom = this.targetWordOpacityForLine(index);
      this.lineStates[index].blur.jump(this.targetBlurForLine(index));
    }
    this.stepMotion(this.lastMotionTime, true);
    this.syncCompletedLines(position, false);
    const sounding = activeIndicesAt(
      this.effectiveStarts,
      this.sungEnds,
      position
    );
    this.updateFill(position, sounding);
    this.updateWordMotion(position, this.activeIndices);
    this.updateBackgroundWordMotion(position, this.activeIndices);
    this.updateInterludeDots(position);
  }

  update(position, duration = this.duration, playing = this.playing) {
    if (this.lines.length === 0) {
      return;
    }
    this.duration = duration;

    if (this.timelineReducedMotion !== this.reduceMotion.matches) {
      this.rebuildTimeline();
    }

    this.playing = Boolean(playing);
    this.element.classList.toggle('is-playing', this.playing);

    const seek =
      this.lastPosition !== null &&
      Math.abs(position - this.lastPosition) > 1;
    const interlude = this.interludeAt(position);
    const actives = interlude >= 0
      ? []
      : activeIndicesAt(this.effectiveStarts, this.focusEnds, position);
    const sounding = interlude >= 0
      ? []
      : activeIndicesAt(this.effectiveStarts, this.sungEnds, position);
    const active = actives.length ? actives[actives.length - 1] : -1;
    const activeKey = actives.join(',');
    const anchor = actives.length
      ? primaryLyricIndex(this.lines, actives, position)
      : interlude >= 0
        ? Math.max(0, this.interludes[interlude].before - 1)
        : 0;
    const changed =
      activeKey !== this.activeKey ||
      interlude !== this.interludeIndex ||
      anchor !== this.anchorIndex;

    if (changed) {
      // The next voice can already be singing before it owns the scroll.
      // When the earlier voice ends, continue onto that existing partner
      // immediately; only a newly arriving phrase needs the normal cascade.
      const continuingOverlap = !seek && interlude < 0 && this.interludeIndex < 0 &&
        anchor > this.anchorIndex && active === this.activeIndex &&
        this.activeIndices.includes(this.anchorIndex) && this.activeIndices.includes(anchor) &&
        !this.lines[this.anchorIndex]?.isBackground && !this.lines[this.anchorIndex]?.isCredit &&
        !this.lines[anchor]?.isBackground && !this.lines[anchor]?.isCredit;
      const previousInterlude = this.interludeIndex;
      this.setInterludeActive(previousInterlude, false);
      this.setInterludeActive(interlude, true);
      this.activeIndex = active;
      this.activeIndices = actives;
      this.activeKey = activeKey;
      this.interludeIndex = interlude;
      // A backing tail can remain active without owning the scroll anchor.
      // Re-evaluate even when the active set is unchanged at a lead's end.
      this.anchorIndex = anchor;
      this.syncCompletedLines(position, !seek);
      this.applyClasses(actives);
      this.syncBackgroundTargets(actives);
      this.updateTargets(this.anchorIndex, {
        seek,
        position,
        interlude,
        holdView: this.element.classList.contains('is-scrolling'),
        stagger: continuingOverlap || this.element.classList.contains('is-scrolling') ? false : undefined
      });
    }

    // Background ownership changes with focus above. Retargeting it on every
    // frame repeats class writes across the entire song while it is unchanged.
    this.syncCompletedLines(position, !seek);
    this.updateFill(position, sounding);
    this.updateWordMotion(position, actives);
    this.updateBackgroundWordMotion(position, actives);
    this.updateInterludeDots(position);
    this.stepMotion();
    this.lastPosition = position;
  }

  // Measure content positions and visual row membership together. Row-local
  // masks let every wrapped row finish concurrently during a handoff. Cache
  // the result until layout changes to avoid measuring during each frame.
  ensureLineFillGeometry(index) {
    const lineElement = this.lineElements[index];
    const words = this.lines[index]?.words;
    const wordElements = this.wordElements[index];
    if (!lineElement || !words?.length ||
        !wordElements?.length || wordElements.length !== words.length) {
      return null;
    }

    const cached = this.fillGeos.get(index);
    if (cached && cached.gen === this.metricsGen && cached.count === words.length) {
      return cached;
    }

    const motions = this.wordMotions[index] ?? [];
    const geo = {
      index, gen: this.metricsGen, count: words.length,
      ...measureFillGeometry(lineElement, wordElements, motions)
    };
    this.fillGeos.set(index, geo);
    // Geometry changed, so drop cached fills to force a rewrite next frame.
    for (const el of wordElements) {
      el.__fill = undefined;
      el.__fadeWidth = undefined;
    }
    for (const plan of motions) {
      for (const char of plan?.chars ?? []) char.lastFill = Number.NaN;
    }
    return geo;
  }

  // One continuous frontier in the running sum of word widths. It advances across
  // each word's box during that word's timing and holds at a word's right edge
  // between words, so the soft band sweeps the whole line and never rewinds at
  // a word boundary. The final word is given one extra fade band of travel so
  // the line actually finishes fully bright.
  computeLineFillFrontier(geo, words, position) {
    let frontier = 0;
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i];
      if (position >= word.end) {
        frontier = i === words.length - 1
          ? geo.prefix[i] + geo.widths[i] + geo.fadeWidth
          : geo.prefix[i] + geo.widths[i];
        continue;
      }
      if (position >= word.time) {
        const duration = word.end - word.time;
        const progress = duration > 0
          ? Math.min(Math.max((position - word.time) / duration, 0), 1)
          : 1;
        const span = i === words.length - 1
          ? geo.widths[i] + geo.fadeWidth
          : geo.widths[i];
        frontier = geo.prefix[i] + span * progress;
      }
      break;
    }
    return frontier;
  }

  // Each word retargets the displayed frontier over its own duration. A short
  // word can therefore increase the speed without jumping to its left edge.
  // Cache the retargets in content space so playback, dropped frames and seeks
  // all produce the same position without accumulating frame history.
  acceleratedFillSegments(geo, words) {
    if (geo.fillSegments) return geo.fillSegments;
    const checkpoints = [];
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      const endpoint = geo.prefix[index] + geo.widths[index];
      const letters = Array.from(word.text ?? '').filter(char => !/\s/u.test(char)).length;
      const previous = checkpoints.at(-1);
      // Syllables with the same timing form one target rather than several
      // instantaneous retargets at the same timestamp.
      if (previous && previous.time === word.time && previous.end === word.end) {
        previous.endpoint = endpoint;
        previous.letters += letters;
      } else {
        checkpoints.push({ time: word.time, end: word.end, endpoint, letters });
      }
    }

    const segments = [];
    for (let index = 0; index < checkpoints.length; index += 1) {
      const checkpoint = checkpoints[index];
      const previous = segments.at(-1);
      const from = previous
        ? previous.from + (previous.to - previous.from) *
          clamp01((checkpoint.time - previous.time) / previous.duration)
        : 0;
      const final = index === checkpoints.length - 1;
      // Short syllables need a narrower lead into the soft band. The final
      // target clears the entire band, including at larger lyric font sizes.
      const extra = geo.fadeWidth * (final ? 1 : checkpoints.length < 3
        ? 0.5 : checkpoint.letters < 3 ? 0.25 : 0.12);
      const to = Math.max(from, checkpoint.endpoint + extra);
      let duration = checkpoint.end - checkpoint.time;
      // Extra travel beyond the final glyph must not abruptly increase the
      // singing speed. Extend that tail proportionally, capped at three times
      // the word duration, and let it finish after the vocal if necessary.
      const remaining = checkpoint.endpoint - from;
      if (final && remaining > 0 && to - from > remaining) {
        duration *= Math.min((to - from) / remaining, 3);
      }
      segments.push({ time: checkpoint.time, from, to, duration: duration > 0 ? duration : 1 });
    }
    geo.fillSegments = segments;
    return segments;
  }

  wordFillFrontierFor(geo, words, position) {
    const segments = this.acceleratedFillSegments(geo, words);
    const last = segments.at(-1);
    geo.fillEnd = last ? last.time + last.duration : 0;
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i];
      if (position < segment.time) continue;
      return segment.from + (segment.to - segment.from) *
        clamp01((position - segment.time) / segment.duration);
    }
    return 0;
  }

  fillAccelerationWindowFor(index, words) {
    const line = this.lines[index];
    const next = this.lines[index + 1];
    const vocalEnd = Math.max(...words.map(word => word.end));
    if (!line || !next || next.isCredit || vocalEnd > next.time) return null;
    const end = Math.max(vocalEnd, lineEndTime(line, this.sungEnds[index]));
    const settleTime = lineSpringSettleTime((next.time - end) * 1000);
    // Begin when the incoming timestamp is within one spring plus the sweep.
    // The outgoing vocal must also be within half a second of the sweep's
    // completion. These are separate gates: row focus is not the fill clock.
    const start = Math.max(line.time,
      next.time - settleTime - fillAccelerationDuration,
      end - 0.5 - fillAccelerationDuration);
    return { start, end: start + fillAccelerationDuration };
  }

  lineFillFrontierFor(index, geo, words, position, accelerationWindow = undefined) {
    if (!this.accelerateFill || this.reduceMotion.matches) {
      geo.fillEnd = words.at(-1)?.end ?? 0;
      return this.computeLineFillFrontier(geo, words, position);
    }
    const natural = this.wordFillFrontierFor(geo, words, position);
    const window = accelerationWindow === undefined
      ? this.fillAccelerationWindowFor(index, words) : accelerationWindow;
    if (!window) return natural;
    const { start, end } = window;
    const from = this.wordFillFrontierFor(geo, words, start);
    const full = geo.total + geo.fadeWidth;
    if (from >= full) return natural;
    geo.fillEnd = end;
    if (position < start) return natural;
    // Linear travel preserves a visible sweep at the start of the handoff.
    // An eased finish would spend most of this short window barely moving.
    return from + (full - from) * clamp01((position - start) / fillAccelerationDuration);
  }

  lineFillFrontiersFor(index, geo, words, position) {
    if (geo.runs.length < 2 || !this.accelerateFill || this.reduceMotion.matches) {
      const frontier = this.lineFillFrontierFor(index, geo, words, position);
      return geo.runs.map(run => frontier - run.start);
    }
    if (!geo.runGeometries) {
      geo.runGeometries = geo.runs.map(run => ({
        total: run.total, fadeWidth: geo.fadeWidth, prefix: [], widths: [], words: []
      }));
      for (let i = 0; i < words.length; i += 1) {
        for (const fragment of geo.wordFragments[i]) {
          const run = geo.runGeometries[fragment.runIndex];
          run.prefix.push(fragment.offset);
          run.widths.push(fragment.width);
          run.words.push(words[i]);
        }
      }
    }
    // A visual row owns its word retargets even before acceleration begins.
    // Subtracting a row offset from one paragraph-wide frontier loses the
    // upper row's feather tail and changes the lower row's starting speed.
    // Each fragment keeps its source word's clock, including a single word
    // that crosses a wrap. The handoff window still belongs to the whole line.
    const window = this.fillAccelerationWindowFor(index, words);
    const frontiers = geo.runGeometries.map(run =>
      this.lineFillFrontierFor(index, run, run.words, position, window));
    geo.fillEnd = Math.max(...geo.runGeometries.map(run => run.fillEnd));
    return frontiers;
  }

  // Karaoke fill. Each visual row's frontier is converted to the participating
  // word's local `--fill`; the CSS mask gradient draws a constant-px
  // bright→dim band there, so sung text is bright and unsung dim. The band
  // trails one fade width behind the frontier, which is what keeps the edge
  // soft across word boundaries instead of snapping at each word.
  updateFill(position, indices = this.activeIndices) {
    // A final feather can still be moving after focus passes to the next row.
    // Paint it through completion instead of freezing it at the vocal end.
    for (const active of new Set([...indices, ...this.fillTails.keys()])) {
      this.updateLineFill(active, position);
      this.updateBackgroundLineFill(active, position);
      const end = Math.max(
        this.fillGeos.get(active)?.fillEnd ?? 0,
        this.backgroundFillGeos.get(active)?.fillEnd ?? 0
      );
      if (position < end && position >= this.lines[active].time) {
        this.fillTails.set(active, end);
      } else {
        this.fillTails.delete(active);
      }
    }
  }

  updateLineFill(active, position) {
    const line = this.lines[active];
    const wordElements = this.wordElements[active];
    if (!line.words?.length ||
        wordElements?.length !== line.words.length) {
      return;
    }

    const geo = this.ensureLineFillGeometry(active);
    if (!geo) {
      return;
    }

    this.paintLineFill(active, position, line.words, wordElements, this.wordMotions[active] ?? [], geo);
  }

  // Lead and backing words share a fill painter so glyph motion cannot leave
  // the bright mask behind on a differently composited parent word.
  paintLineFill(active, position, words, wordElements, plans, geo) {
    const frontiers = this.lineFillFrontiersFor(
      active, geo, words, position
    );

    for (let index = 0; index < words.length; index += 1) {
      const wordRun = geo.wordRuns[index];
      const rawFill = frontiers[wordRun.runIndex] - wordRun.offset - geo.fadeWidth;
      const wordWidth = geo.widths[index];
      // Clamp to [-fadeWidth, wordWidth]: outside this window the gradient band
      // is completely clear of the word box, so keeping `--fill` stationary
      // avoids forcing WebKit to re-rasterize CPU gradient masks on every
      // already-sung and not-yet-sung word in the line on every frame.
      const fill = Math.min(wordWidth, Math.max(-geo.fadeWidth, rawFill));
      const el = wordElements[index];
      if (el.__fadeWidth !== geo.fadeWidth) {
        el.__fadeWidth = geo.fadeWidth;
        el.style.setProperty('--fade-width', `${geo.fadeWidth.toFixed(2)}px`);
      }

      // Words that own glyph boxes have to be filled per glyph, because a
      // composited glyph no longer receives an ancestor's clipped background.
      const plan = plans[index];
      if (plan?.chars?.length) {
        const glyphWidths = geo.charWidths?.[index];
        for (let c = 0; c < plan.chars.length; c += 1) {
          const char = plan.chars[c];
          const charRun = geo.charRuns[index][c];
          const rawLocal = frontiers[charRun.runIndex] - charRun.offset - geo.fadeWidth;
          const charWidth = glyphWidths ? glyphWidths[c] : wordWidth;
          const local = Math.min(charWidth, Math.max(-geo.fadeWidth, rawLocal));
          if (char.lastFill !== local) {
            char.lastFill = local;
            (char.glyph ?? char.motion).style.setProperty(
              '--char-fill', `${local.toFixed(3)}px`
            );
          }
        }
        continue;
      }

      if (el.__fill !== fill) {
        el.__fill = fill;
        el.style.setProperty('--fill', `${fill.toFixed(3)}px`);
      }
    }
  }

  // Same constant-px frontier as the lead line, but measured across the
  // background block's words. The block is hidden with a transform while a
  // line is out of focus, so its geometry is measured with animations at rest —
  // a scaled bounding box would bake the entrance zoom into the fill widths.
  ensureBackgroundFillGeometry(index) {
    const lineElement = this.lineElements[index];
    const words = this.lines[index]?.backgroundWords;
    const wordElements = this.backgroundWordElements[index];
    if (!lineElement || !words?.length ||
        !wordElements?.length || wordElements.length !== words.length) {
      return null;
    }

    const cached = this.backgroundFillGeos.get(index);
    if (cached && cached.gen === this.metricsGen && cached.count === words.length) {
      return cached;
    }

    const background = this.backgroundStates[index]?.element;
    const savedBlockTransform = background?.style.transform;
    if (background) {
      background.style.transform = '';
    }

    let geometry;
    try {
      geometry = measureFillGeometry(lineElement, wordElements, this.backgroundWordMotions[index]);
    } finally {
      if (background) background.style.transform = savedBlockTransform ?? '';
    }
    const geo = { index, gen: this.metricsGen, count: words.length, ...geometry };
    this.backgroundFillGeos.set(index, geo);
    for (const el of wordElements) {
      el.__fill = undefined;
    }
    for (const plan of this.backgroundWordMotions[index] ?? []) {
      for (const char of plan.chars ?? []) char.lastFill = Number.NaN;
    }
    return geo;
  }

  updateBackgroundLineFill(active, position) {
    const words = this.lines[active]?.backgroundWords;
    const elements = this.backgroundWordElements[active];
    if (!words?.length || elements?.length !== words.length) {
      return;
    }

    const geo = this.ensureBackgroundFillGeometry(active);
    if (!geo) {
      return;
    }

    this.paintLineFill(active, position, words, elements, this.backgroundWordMotions[active] ?? [], geo);
  }

  // Backing words follow their own clocks with a small whole-word lift.
  // Sustained notes keep this simple motion instead of adding emphasis.
  updateBackgroundWordMotion(position, indices = this.activeIndices) {
    if (this.reduceMotion.matches) {
      for (let index = 0; index < this.backgroundWordMotions.length; index += 1) {
        this.resetBackgroundWordMotion(index);
      }
      return;
    }

    for (const active of indices) {
      if (this.backgroundStates[active] && !this.backgroundStates[active].isActive) {
        continue;
      }
      this.updateWordPlans(this.backgroundWordMotions[active], position, backgroundWordRisePeak);
    }
  }

  resetBackgroundWordMotion(index) {
    for (const word of this.backgroundWordMotions[index] ?? []) {
      word.last = Number.NaN;
      for (const target of word.targets) target.style.transform = '';
      for (const char of word.chars ?? []) {
        char.lastTransform = '';
        char.motion.style.transform = '';
        if (char.glow) {
          char.lastOpacity = 0;
          char.glow.style.opacity = '0';
        }
      }
    }
  }

  // Backing vocals open with a soft spring and close with a critically damped
  // response. Alpha has its own spring instead of a second CSS fade clock.
  syncBackgroundTargets(actives) {
    const owner = actives.includes(this.anchorIndex) ? this.anchorIndex : -1;
    for (let index = 0; index < this.backgroundStates.length; index += 1) {
      const state = this.backgroundStates[index];
      if (!state) {
        continue;
      }
      const wasActive = state.isActive;
      state.isActive = index === owner;
      if (state.isActive === wasActive) continue;
      state.element.classList.toggle('is-background-active', state.isActive);
      const params = state.isActive ? activeScaleSpring : inactiveScaleSpring;
      state.slide.configure(params.stiffness, params.damping, params.mass);
      state.opacity.configure(params.stiffness, params.damping, params.mass);
      state.slide.moveTo(state.isActive ? 0 : state.hiddenTarget);
      state.opacity.moveTo(state.isActive ? 0.3 : 0);
      if (state.isActive) {
        state.lastHidden = false;
        state.element.classList.remove('is-background-hidden');
      }
    }
  }

  // Row springs operate in the final background layout. Cancel the transient
  // slot heights at render time so a backing spring cannot add a second
  // positional animation on top of a row's own scroll/collapse spring.
  syncBackgroundLayout(retarget = false) {
    for (const state of this.backgroundStates) {
      if (!state?.layoutDirty) {
        continue;
      }
      state.layoutHeight = state.slot.getBoundingClientRect().height;
      state.layoutDirty = false;
    }

    const currentHeights = [0];
    const targetHeights = [0];
    for (let index = 0; index < this.lineStates.length; index += 1) {
      const background = this.backgroundStates[index];
      const current = background?.layoutHeight ?? 0;
      const target = background?.isActive ? background.height : 0;
      this.syncLineBackgroundLayout(
        this.lineStates[index],
        currentHeights[index] + (background?.isBefore ? current : 0),
        targetHeights[index] + (background?.isBefore ? target : 0),
        retarget
      );
      currentHeights.push(currentHeights[index] + current);
      targetHeights.push(targetHeights[index] + target);
    }
    for (let index = 0; index < this.interludeStates.length; index += 1) {
      const before = this.interludes[index].before;
      this.syncLineBackgroundLayout(
        this.interludeStates[index], currentHeights[before], targetHeights[before], retarget
      );
    }
  }

  syncLineBackgroundLayout(state, currentHeight, targetHeight, retarget) {
    if (retarget) {
      // Changing the final layout is a coordinate change, not another move.
      // Preserve rendered position, velocity and any queued stagger before
      // updateTargets assigns the one new destination to the row spring.
      const shift = state.backgroundTargetHeight - targetHeight;
      if (shift !== 0) {
        state.y.shiftBy(shift);
      }
      state.backgroundTargetHeight = targetHeight;
    }
    state.backgroundOffset = state.backgroundTargetHeight - currentHeight;
  }

  // Word and character motion, matching Apple Music. Every frame the motion is
  // derived from the playback position alone, so pausing, seeking and revisiting
  // a line stay exact with no animation bookkeeping. Writes are restricted to
  // `transform` and `opacity` — the two properties the compositor can animate on
  // its own — so the lift, the stagger and the glow all run on the GPU instead
  // of repainting text.
  updateWordMotion(position, indices = this.activeIndices) {
    for (const active of indices) {
      this.updateLineWordMotion(active, position);
    }
  }

  updateLineWordMotion(active, position) {
    const risePeak = this.lines[active]?.isBackground ? backgroundWordRisePeak : wordRisePeak;
    this.updateWordPlans(this.wordMotions[active], position, risePeak);
  }

  updateWordPlans(words, position, risePeak) {
    if (!words?.length) {
      return;
    }

    for (const word of words) {
      const elapsed = (position - word.start) * 1000;
      const params = word.params;

      if (!params) {
        const offset = elapsed <= 0 ? 0 : wordRiseOffset(elapsed) * (risePeak / wordRisePeak);
        if (word.last !== offset) {
          word.last = offset;
          const transform = `translate3d(0, ${offset.toFixed(4)}px, 0)`;
          for (const target of word.targets) {
            target.style.transform = transform;
          }
        }
        continue;
      }

      const spanMs = params.spanDuration * 1000;
      const cjk = params.cjk;
      const {
        emphasis, scaleDelta = 0, liftExtra = 0, glow, hold, response, response2
      } = params;

      if (word.avgAdvance === undefined && scaleDelta > 0) {
        let width = 0;
        for (const char of word.chars) {
          width += char.motion.offsetWidth;
        }
        word.avgAdvance = word.chars.length ? width / word.chars.length : 0;
      }
      const advance = word.avgAdvance || 0;

      let glowLevel = 0;
      if (glow > 0) {
        const t = position - params.start;
        glowLevel = glow * Math.max(0,
          springProgress(t, response) - springProgress(t - params.glowOff, response));
      }

      for (const char of word.chars) {
        const local = elapsed - char.delayMs;
        let dx = 0;
        let dy = 0;
        let scale = 1;

        if (local >= spanMs) {
          dy = risePeak;
        } else if (local > 0) {
          const time = local / 1000;
          const s0 = springProgress(time, response);
          const s1 = springProgress(time - hold, response2);
          const s11 = cjk
            ? 1 - springPosition(time, wordRiseFrequency, 3.5)
            : springProgress(time, response);
          // Reduced motion keeps the lift of the word itself but drops the
          // per-glyph flourish: no spread, no scale pulse, no extra lift.
          const pulse = emphasis > 0 && !this.reduceMotion.matches ? s0 * (1 - s1) : 0;
          dy = risePeak * (s11 + liftExtra * pulse);
          dx = char.offset * scaleDelta * pulse * advance;
          scale = 1 + scaleDelta * pulse;
        }

        const transform =
          `translate3d(${dx.toFixed(4)}px, ${dy.toFixed(4)}px, 0) scale(${scale.toFixed(4)})`;
        if (char.lastTransform !== transform) {
          char.lastTransform = transform;
          char.motion.style.transform = transform;
        }

        if (char.glow) {
          const opacity = Number(glowLevel.toFixed(3));
          if (char.lastOpacity !== opacity) {
            char.lastOpacity = opacity;
            char.glow.style.opacity = opacity.toFixed(3);
          }
        }
      }
    }
  }

  // A duet is two voices answering each other. TTML names the voice per line
  // (`ttm:agent`), so the first voice stays left and the answering voice is
  // set flush right, alternating for any further voices. Without that
  // metadata, overlapping timings are the only clue: a line that starts while
  // the previous one is still being sung is the answer. Alignment is decided
  // once, at build time, so a line can never jump sides mid-phrase.
  applyDuetAlignment() {
    const sides = new Map();
    for (const line of this.lines) {
      if (line.voice && !sides.has(line.voice)) {
        sides.set(line.voice, sides.size);
      }
    }

    for (let index = 0; index < this.lineElements.length; index += 1) {
      const voice = this.lines[index]?.voice;
      const side = voice && sides.has(voice)
        ? sides.get(voice)
        : sides.size === 0 &&
            index > 0 &&
            this.lines[index].time < this.boundaryEnds[index - 1]
          ? 1
          : 0;
      // A right-to-left line already sits on the right edge, so the answering
      // voice must not be pushed over to the left: Arabic and Hebrew duets
      // keep every line right-aligned.
      const element = this.lineElements[index];
      const isRtl = element.dir === 'rtl';
      element.classList.toggle(
        'is-duet',
        !this.lines[index].isCredit && !isRtl && side % 2 === 1
      );
    }
  }

  // `active` is every line currently being sung, in order. Normally that is one
  // line; when timings overlap it can include a second voice, and both stay
  // crisp. Blur and "near" are measured from the outermost active lines so
  // the neighbours still fade with distance.
  applyClasses(active = this.activeIndices) {
    const sung = new Set(active);
    const first = active.length ? active[0] : this.anchorIndex;
    const last = active.length ? active[active.length - 1] : first;
    const creditIndex = this.lines.findIndex(line => line.isCredit);
    const creditsActive = active.some(index => this.lines[index]?.isCredit);
    const creditDistance = creditIndex < first
      ? first - creditIndex + 1
      : Math.abs(creditIndex - last);
    const creditBlur = creditsActive ? 0 : Math.min(6, (creditDistance + 0.75) * 1.25);
    this.targetBlurs = new Array(this.lineElements.length);

    for (let index = 0; index < this.lineElements.length; index += 1) {
      const element = this.lineElements[index];
      const isSung = sung.has(index);
      const distance = isSung
        ? 0
        : index < first
          ? first - index + 1
          : Math.abs(index - last);
      element.classList.toggle('is-active', isSung);
      element.classList.toggle(
        'is-near',
        !isSung && distance === 1
      );
      element.classList.toggle(
        'is-far',
        !isSung && distance !== 1
      );
      const level = (distance + 0.75) * 1.25;
      const blur = this.lines[index]?.isCredit
        ? creditBlur
        : isSung ? 0 : Math.min(6, level);
      this.targetBlurs[index] = blur;
      if (this.reduceMotion.matches) {
        this.resetBackgroundWordMotion(index);
      }
    }
  }

  // Manual scroll: the wheel offsets every row from the playing line. Line
  // changes keep running underneath but do not move the view until the user
  // has been idle for scrollReturnMs (or taps a line), then it glides back.
  onWheel(event) {
    if (!this.interactionEnabled) return;
    if (this.lineStates.length === 0 || this.anchorIndex < 0) {
      return;
    }

    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const delta = event.deltaY * unit;
    if (!delta) {
      return;
    }

    const anchor = this.lineElements[this.anchorIndex];
    const first = this.lineElements[0];
    const last = this.lineElements[this.lineElements.length - 1];
    const upTo = anchor.offsetTop - first.offsetTop;
    const downTo = last.offsetTop - anchor.offsetTop;
    this.scrollOffset = Math.min(upTo, Math.max(-downTo, this.scrollOffset - delta));
    this.element.classList.add('is-scrolling');
    this.updateTargets(this.anchorIndex, {
      scrolling: true,
      stagger: false,
      interlude: this.interludeIndex
    });

    clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => this.endManualScroll(), scrollReturnMs);
  }

  endManualScroll() {
    clearTimeout(this.scrollTimer);
    this.scrollTimer = 0;
    if (!this.element.classList.contains('is-scrolling')) {
      return;
    }

    this.element.classList.remove('is-scrolling');
    this.scrollOffset = 0;
    if (this.anchorIndex >= 0) {
      this.updateTargets(this.anchorIndex, {
        seek: true,
        interlude: this.interludeIndex
      });
    }
  }

  updateTargets(active, options = {}) {
    const interlude = Number.isInteger(options.interlude)
      ? options.interlude
      : -1;
    const focus = interlude >= 0
      ? this.interludes[interlude]?.element
      : this.lineElements[active];
    if (!focus) {
      return;
    }

    this.syncBackgroundLayout(true);

    // Measure the lead text, never the lead-plus-background paragraph.
    const anchor = focus.querySelector('.lyrics-main-text') ?? focus;
    const focusRect = focus.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const trackRect = this.track.getBoundingClientRect();
    const trackWidth = Number.parseFloat(getComputedStyle(this.track).width);
    // Style switches and sheets scale the whole player while it is measured.
    // Convert screen coordinates back to layout units before aiming a spring,
    // or the temporary parent scale becomes a permanent lyric offset.
    const scale = trackWidth > 0 && trackRect.width > 0 ? trackRect.width / trackWidth : 1;
    const style = getComputedStyle(this.element);
    const alignmentValue = Number.parseFloat(style.getPropertyValue('--lyrics-anchor-alignment'));
    const alignment = Number.isFinite(alignmentValue) ? Math.min(1, Math.max(0, alignmentValue)) : 0.5;
    const focusState = interlude >= 0
      ? this.interludeStates[interlude]
      : this.lineStates[active];
    const renderedY = Number.isFinite(focusState?.lastY) ? focusState.lastY : 0;
    // offsetTop rounds to whole pixels. Feeding that rounding back into a
    // moving spring retargets it in steps; measure the untransformed origin.
    const layoutTop = (focusRect.top - trackRect.top) / scale - renderedY;
    const anchorOffset =
      layoutTop +
      (anchorRect.top - focusRect.top) / scale +
      anchorRect.height / scale * alignment;

    // Include the final-layout correction once in the destination. Slot
    // animation then changes only the render correction, never this target.
    const anchorRatio = Number.parseFloat(style.getPropertyValue('--lyrics-anchor-ratio')) || 0.3815;
    const anchorHeight = style.getPropertyValue('--lyrics-anchor-basis').trim() === 'container'
      ? this.element.clientHeight : window.innerHeight;
    const anchorPadding = Number.parseFloat(style.getPropertyValue('--lyrics-anchor-padding')) || 0;
    const base =
      anchorHeight * anchorRatio + anchorPadding - anchorOffset - focusState.backgroundOffset;
    // A line change during manual scroll re-bases the offset instead of
    // moving the view, so the rows the user is reading stay where they are.
    if (options.holdView && this.lineStates.length) {
      this.scrollOffset = this.lineStates[0].y.target - base;
    }
    const target = base + this.scrollOffset;
    const baseParams = this.dynamicLineSpring(active, interlude, options.seek);
    let urgentTimeLeft = Infinity;
    let urgentMovement = false;
    if (
      !options.seek &&
      !options.initial &&
      !options.scrolling &&
      !options.preserveDelay &&
      !this.reduceMotion.matches &&
      interlude < 0 &&
      Number.isFinite(options.position)
    ) {
      const urgentIndex = this.activeIndex >= 0 ? this.activeIndex : active;
      const urgentLine = this.lines[urgentIndex];
      if (urgentLine && !urgentLine.isBackground && !urgentLine.isCredit) {
        const urgentEnd = lineEndTime(urgentLine, this.sungEnds[urgentIndex]);
        if (Number.isFinite(urgentEnd)) {
          urgentTimeLeft = urgentEnd - 0.5 - options.position;
          // A timed vocal with less than 0.9s left moves every row immediately,
          // so the cascade cannot hold the next phrase behind its short ending.
          urgentMovement = Boolean(urgentLine.words?.length) && urgentTimeLeft < 0.4;
        }
      }
    }
    const dynamicParams = compressSpringParams(baseParams, urgentTimeLeft);
    const scaleParams = dynamicParams;
    // Alpha compression shares the movement response only when that response
    // is shortened. Very short remaining phrases use the fixed 0.3s response.
    const opacityParams = options.seek ? seekSpring
      : urgentTimeLeft < 0.4 ? urgentOpacitySpring
        : dynamicParams !== baseParams ? dynamicParams : null;
    // Restore the previous interval-dependent response without changing the
    // stagger or resetting the position/velocity of a line already moving.
    const params = options.scrolling
      ? scrollSpring
      : dynamicParams;
    const stagger =
      !this.reduceMotion.matches &&
      !urgentMovement &&
      interlude < 0 &&
      !options.initial &&
      !options.seek &&
      options.stagger !== false;
    let delay = 0;
    const baseDelay = stagger ? lineDelay : 0;

    for (let index = 0; index < this.lineStates.length; index += 1) {
      const state = this.lineStates[index];
      const line = this.lineElements[index];
      const scaleTarget = this.targetScaleForLine(index);
      const opacityTarget = this.targetOpacityForLine(index);
      const wordOpacityTarget = this.targetWordOpacityForLine(index);
      const blurTarget = this.targetBlurForLine(index);
      // Layout callbacks must not replace a seek's glide with the normal
      // advance spring halfway through the same movement.
      if (!options.preserveDelay) {
        state.y.configure(params.stiffness, params.damping, params.mass);
      }
      const backgroundState = this.backgroundStates[index];
      // A pure re-layout (resize, or the track's height changing because an
      // interlude just collapsed) must not cancel a stagger that is already
      // running: re-aim the line and keep its pending delay.
      if (options.preserveDelay) {
        state.y.retarget(target);
        state.scale.retarget(scaleTarget);
      } else {
        state.y.moveTo(target, delay);
        const pendingScaleTarget = state.scale.queuedTarget ?? state.scale.target;
        if (Math.abs(pendingScaleTarget - scaleTarget) > 0.01) {
          const backgroundFocusScale =
            !options.seek &&
            !options.initial &&
            !options.scrolling &&
            this.lines[index]?.isBackground;
          const lineScaleParams = backgroundFocusScale
            ? (line.classList.contains('is-active')
                ? activeScaleSpring
                : inactiveScaleSpring)
            : scaleParams;
          state.scale.configure(
            lineScaleParams.stiffness,
            lineScaleParams.damping,
            lineScaleParams.mass
          );
          state.scale.moveTo(scaleTarget, delay);
        }
      }
      // Text alpha is independent of the row cascade. A timed line exposes
      // its bright fill immediately on activation, while its unsung text has
      // a separate absolute alpha. Keep both masks while it dims on exit.
      const timed = Boolean(this.lines[index]?.words?.length);
      for (const [alpha, alphaTarget, fromKey] of [
        [state.opacity, opacityTarget, 'opacityFrom'],
        [state.wordOpacity, wordOpacityTarget, 'wordOpacityFrom']
      ]) {
        if (Math.abs(alpha.target - alphaTarget) <= 0.0001) continue;
        state[fromKey] = Math.min(Math.max(alpha.value,
          Math.min(state[fromKey], alpha.target)), Math.max(state[fromKey], alpha.target));
        if (timed && opacityParams && !options.preserveDelay) {
          alpha.configure(opacityParams.stiffness, opacityParams.damping, opacityParams.mass);
        }
        if (timed && alpha === state.opacity && line.classList.contains('is-active')) {
          alpha.jump(alphaTarget);
        } else {
          alpha.moveTo(alphaTarget);
        }
      }
      // The blur tween always starts at the target change, including a seek;
      // neither a row's stagger nor its urgency changes the 120ms duration.
      state.blur.moveTo(blurTarget);
      if (stagger) {
        const bottomCorrection = backgroundState && !backgroundState.isBefore
          ? (backgroundState.isActive ? backgroundState.height : 0) - backgroundState.layoutHeight
          : 0;
        const lineBottom =
          line.offsetTop + target + state.backgroundOffset + line.offsetHeight + bottomCorrection;
        if (lineBottom >= 0) {
          // Apple Music holds the stagger constant: the top visible line
          // starts at 0, then every following line starts 50 ms later.
          delay += baseDelay;
        }
      }
      this.bindCompletedFade(index);
    }

    for (const state of this.interludeStates) {
      if (options.preserveDelay) {
        state.y.retarget(target);
      } else {
        state.y.configure(params.stiffness, params.damping, params.mass);
        state.y.moveTo(target);
      }
    }

  }

  renderBackgroundState(state, force = false) {
    // Clamp the small spring overshoot so the reveal cannot shrink/reopen
    // after reaching an endpoint. Row placement is independent of this curve.
    const progress = clamp01(1 - state.slide.value / state.hiddenTarget);
    const height = Math.round(state.height * progress * 100) / 100;
    if (height !== state.lastLayoutHeight) {
      state.lastLayoutHeight = height;
      state.slot.style.height = `${height}px`;
      state.layoutDirty = true;
    }
    const slide = Math.round(state.slide.value * 10000) / 10000;
    const opacity = clamp01(state.opacity.value / 0.3) * 0.3;
    if (!force && slide === state.lastSlide && opacity === state.lastOpacity) {
      return;
    }

    state.lastSlide = slide;
    state.lastOpacity = opacity;
    state.element.style.setProperty('--background-opacity', opacity.toFixed(4));
    const translate = (slide / 100) * state.height;
    const scale = 0.9 + progress * 0.1;
    state.element.style.transform =
      `translate3d(0, ${translate.toFixed(4)}px, 0) ` +
      `scale(${scale.toFixed(4)})`;

    const hidden = !state.isActive &&
      Math.abs(slide - state.hiddenTarget) < 0.1 && opacity < 0.001;
    if (hidden && state.lastHidden !== true) this.resetBackgroundWordMotion(state.index);
    if (force || hidden !== state.lastHidden) {
      state.lastHidden = hidden;
      state.element.classList.toggle('is-background-hidden', hidden);
    }
  }

  stepMotion(now = performance.now(), force = false) {
    if (this.lineStates.length === 0) {
      return;
    }

    const delta = this.lastMotionTime
      ? (now - this.lastMotionTime) / 1000
      : 0;
    this.lastMotionTime = now;
    for (const index of this.completedFades.keys()) this.bindCompletedFade(index);
    const instant = this.reduceMotion.matches;

    for (const state of this.backgroundStates) {
      if (!state) {
        continue;
      }
      if (instant) {
        state.slide.jump(state.slide.queuedTarget ?? state.slide.target);
        state.opacity.jump(state.opacity.target);
      } else {
        state.slide.update(delta);
        state.opacity.update(delta);
      }
      this.renderBackgroundState(state, force);
    }

    // Cancel slot reflow in this frame. Only each row's y spring is allowed
    // to move its lead text; backing height/slide is a separate visual reveal.
    this.syncBackgroundLayout();
    for (const state of this.lineStates) {
      if (instant) {
        // A preference change can interrupt a stagger: its destination is
        // queuedTarget, while target still belongs to the previous line.
        state.y.jump(state.y.queuedTarget ?? state.y.target);
        state.scale.jump(state.scale.queuedTarget ?? state.scale.target);
        state.opacity.jump(state.opacity.queuedTarget ?? state.opacity.target);
        state.wordOpacity.jump(state.wordOpacity.target);
        state.blur.jump(state.blur.target);
      } else {
        state.y.update(delta);
        state.scale.update(delta);
        state.opacity.update(delta);
        state.wordOpacity.update(delta);
        state.blur.update(delta);
      }

      this.renderLinePosition(state, force);
    }

    this.stepCompletedFades();

    for (const state of this.interludeStates) {
      if (instant) {
        state.y.jump(state.y.queuedTarget ?? state.y.target);
      } else {
        state.y.update(delta);
      }

      this.renderLinePosition(state, force);
    }

  }

  renderLinePosition(state, force = false) {
    const y = Math.round((state.y.value + state.backgroundOffset) * 10000) / 10000;
    const focusScale = state.scale?.value ?? 1;
    const press = state.press?.value ?? 1;
    const scale = Math.round(focusScale * press * 100000) / 100000;
    // Press around the row's centre while focus scaling keeps its reading edge.
    const pressX = press === 1 ? 0 : state.element.offsetWidth * 0.5 *
      focusScale * (1 - press) * (state.element.classList.contains('is-duet') ? -1 : 1);
    if (force || y !== state.lastY || scale !== state.lastScale || pressX !== state.lastPressX) {
      state.lastPressX = pressX;
      state.lastY = y;
      state.lastScale = scale;
      state.element.style.transform = scale === 1
        ? `translate3d(${pressX}px, ${y}px, 0)`
        : `translate3d(${pressX}px, ${y}px, 0) scale(${scale})`;
    }
    if (state.opacity) {
      const alphaValue = (alpha, from) => Math.min(Math.max(alpha.value,
        Math.min(from, alpha.target)), Math.max(from, alpha.target));
      let bright = alphaValue(state.opacity, state.opacityFrom);
      let dim = alphaValue(state.wordOpacity, state.wordOpacityFrom);
      // Readability applies to the whole inactive set. Keep the sung row's
      // independent word mask intact while the pointer moves through it.
      if (this.interactionEnabled && !state.element.classList.contains('is-active') &&
          !state.element.classList.contains('is-background')) {
        const hover = clamp01(this.readability.value);
        bright += Math.max(0, hoverOpacity - bright) * hover;
        dim += Math.max(0, hoverOpacity - dim) * hover;
      }
      const opacity = Math.round(bright * 10000) / 10000;
      if (force || opacity !== state.lastOpacity) {
        state.lastOpacity = opacity;
        state.element.style.setProperty('--line-opacity', String(opacity));
      }
      // CSS multiplies the mask by row opacity, so divide the independently
      // animated absolute dim alpha by bright alpha exactly once.
      const darkAlpha = bright > 0.001
        ? Math.round(clamp01(dim / bright) * 10000) / 10000 : 1;
      if (force || darkAlpha !== state.lastDarkAlpha) {
        state.lastDarkAlpha = darkAlpha;
        state.element.style.setProperty('--word-dark-alpha', String(darkAlpha));
      }
    }
    if (state.blur) {
      const radius = state.blur.value * (1 - clamp01(state.hoverBlur?.value ?? 0));
      const blur = radius <= 0.1 ? 0 : Math.round(radius * 10000) / 10000;
      if (force || blur !== state.lastBlur) {
        state.lastBlur = blur;
        state.element.style.setProperty('--line-blur', `${blur}px`);
      }
    }
    if (state.hoverPlate) this.renderLineHover(state);
  }

  positionTrack() {
    if (this.lineElements.length === 0 || this.anchorIndex < 0) {
      return;
    }

    for (const state of this.backgroundStates) {
      if (!state) {
        continue;
      }
      state.height = state.inner
        ? Number.parseFloat(getComputedStyle(state.inner).height) || 0
        : 0;
    }
    for (const state of this.backgroundStates) {
      if (state) {
        this.renderBackgroundState(state, true);
      }
    }

    this.updateTargets(this.anchorIndex, {
      stagger: false,
      interlude: this.interludeIndex,
      // This is a pure re-layout — a resize, or the track changing height
      // because an interlude just collapsed. Keep any stagger that is
      // already running rather than flattening it into one jump.
      preserveDelay: true
    });
    // ResizeObserver runs before paint, sometimes after the animation tick.
    // Apply its layout compensation now to avoid a one-frame downward jump.
    for (const state of this.lineStates) {
      this.renderLinePosition(state);
    }
    for (const state of this.interludeStates) {
      this.renderLinePosition(state);
    }
    this.measureLineHover();
  }
}
