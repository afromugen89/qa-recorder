import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Frame, Locator as PwLocator, Page } from 'playwright';
import {
  dateBoundaries, edgeCases, lengthBoundaries, lengthPartitions, numberBoundaries, numberPartitions,
  suggestCases, type BvaMode, type FieldConstraints, type TestValue,
} from './boundaries.js';
import { DataGenerator, describeCatalog, listLocales, type GeneratorSpec } from './faker.js';
import { ISTQB_TECHNIQUES, type TechniqueId } from './techniques.js';
import type { ActionEvent, ElementInfo, Locator, LoopEvent, TestDataTag } from '../recorder/types.js';

/** The field the QA last clicked into, per tab. */
export interface FieldTarget {
  frame: Frame;
  framePath: string[];
  locator: Locator;
  element: ElementInfo;
  label: string;
  constraints: FieldConstraints & { options?: { value: string; label: string }[] };
}

export interface ProfileField {
  label: string;
  framePath: string[];
  selector: string;
  /** Element kind, so a select is filled with selectOption. */
  tag: string;
  spec: GeneratorSpec;
}

export interface Profile {
  name: string;
  createdAt: string;
  url?: string;
  fields: ProfileField[];
}

/** How a step's value is chosen on each loop iteration. */
export type StepValue = { mode: 'keep' } | { mode: 'generate'; spec: GeneratorSpec };

export interface LoopRunOptions {
  iterations: number;
  /** Pause between iterations. */
  delayMs?: number;
  /** Reload the page where capture started before each iteration. */
  reload?: boolean;
  /** Per captured step (by seq), how to choose its value. Steps not listed keep their default. */
  values?: Record<string, StepValue>;
}

/** What DataService needs from the recorder. */
export interface DataHost {
  pageById(id: number): Page | undefined;
  pageIdOf(page: Page): number;
  actions(): ActionEvent[];
  lastSeq(): number;
  expectTestData(pageId: number, selector: string, tag: TestDataTag): void;
  setLoopContext(context: { runId: number; iteration: number } | undefined): void;
  pushLoopEvent(event: Omit<LoopEvent, 'seq' | 'timestamp' | 'elapsedMs' | 'type'>): void;
  waitForApiIdle(timeoutMs: number): Promise<void>;
  /** Calls a method on the QA tools UI. */
  notify(method: string, payload: unknown): void;
}

const TECHNIQUE_FOR_KIND: Record<string, TechniqueId> = {
  boundary: 'boundary-value-analysis',
  partition: 'equivalence-partitioning',
  'edge-case': 'error-guessing',
};

function scopeFor(page: Page, framePath: string[]) {
  let scope: Page | ReturnType<Page['frameLocator']> = page;
  for (const selector of framePath) scope = scope.frameLocator(selector);
  return scope;
}

/**
 * Backs the in-browser test data panel: Faker generation, boundary and
 * partition cases, filling the focused field, data profiles and the looper.
 * Every value it puts on the page is tagged with its source and ISTQB
 * technique, and that tag lands on the recorded action.
 */
export class DataService {
  readonly generator: DataGenerator;
  private readonly targets = new Map<number, FieldTarget>();
  private capture?: { pageId: number; startSeq: number; url: string; endSeq?: number };
  private nextRunId = 1;
  private running?: { runId: number; stop: boolean };

  constructor(
    private readonly host: DataHost,
    private readonly profilesPath: string,
    seed?: number,
  ) {
    this.generator = new DataGenerator(seed);
  }

  // ---------- events from the page ----------

  async onFocus(page: Page, frame: Frame, payload: Omit<FieldTarget, 'frame' | 'framePath'>, framePath: string[]) {
    const pageId = this.host.pageIdOf(page);
    const target: FieldTarget = { ...payload, frame, framePath };
    this.targets.set(pageId, target);
    this.host.notify('setTarget', { pageId, ...this.describeTarget(target) });
  }

  private describeTarget(t: FieldTarget) {
    return {
      label: t.label,
      locator: t.locator.code,
      inFrame: t.framePath.length > 0,
      inShadowDom: t.element.inShadowDom,
      constraints: t.constraints,
      suggestions: this.safeSuggest(t.constraints, '2-value'),
    };
  }

  private safeSuggest(c: FieldConstraints, mode: BvaMode): TestValue[] {
    try {
      return suggestCases(c, mode);
    } catch {
      return [];
    }
  }

  /** Handles a command from the panel. Errors are returned, not thrown, so the panel can show them. */
  async handle(page: Page, command: { cmd: string; [key: string]: unknown }): Promise<unknown> {
    try {
      return { ok: true, result: await this.dispatch(page, command) };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  private async dispatch(page: Page, c: { cmd: string; [key: string]: unknown }): Promise<unknown> {
    const pageId = this.host.pageIdOf(page);
    switch (c.cmd) {
      case 'init':
        return {
          catalog: describeCatalog(),
          locales: listLocales(),
          techniques: Object.entries(ISTQB_TECHNIQUES).map(([id, t]) => ({ id, name: t.name })),
          edgeCases: edgeCases(),
          target: this.targets.has(pageId) ? { pageId, ...this.describeTarget(this.targets.get(pageId)!) } : null,
          profiles: this.loadProfiles(),
          capture: this.captureState(),
          seed: this.generator.seed,
        };
      case 'preview':
        return this.generator.generateMany(c.spec as GeneratorSpec, Number(c.count ?? 5));
      case 'fillGenerated': {
        const spec = c.spec as GeneratorSpec;
        const value = this.generator.generate(spec);
        const tag: TestDataTag = { source: 'faker', technique: 'random-testing', label: this.generator.label(spec), spec };
        return { value, ...(await this.fillTarget(pageId, value, tag, false)) };
      }
      case 'fillValue': {
        const tv = c.value as TestValue & { kind?: string };
        const tag: TestDataTag = {
          source: (tv.kind as TestDataTag['source']) ?? 'manual',
          technique: tv.technique ?? TECHNIQUE_FOR_KIND[tv.kind ?? ''],
          label: tv.label,
          expected: tv.expected,
        };
        return this.fillTarget(pageId, tv.value, tag, Boolean(c.bypassMaxLength));
      }
      case 'cases':
        return this.cases(c);
      case 'profiles':
        return this.loadProfiles();
      case 'addToProfile':
        return this.addToProfile(pageId, String(c.profile ?? '').trim(), c.spec as GeneratorSpec);
      case 'removeProfileField':
        return this.updateProfiles((all) => {
          const p = all.find((x) => x.name === c.profile);
          if (p) p.fields.splice(Number(c.index), 1);
        });
      case 'deleteProfile':
        return this.updateProfiles((all) => all.splice(0, all.length, ...all.filter((x) => x.name !== c.profile)));
      case 'applyProfile':
        return this.applyProfile(page, String(c.profile));
      case 'captureStart':
        return this.captureStart(page);
      case 'captureEnd':
        return this.captureEnd();
      case 'captureCancel':
        this.capture = undefined;
        return this.captureState();
      case 'loopRun':
        return this.runLoop(c.options as LoopRunOptions, (status) => this.host.notify('loopStatus', status));
      case 'loopStop':
        if (this.running) this.running.stop = true;
        return true;
      default:
        throw new Error(`Unknown command ${c.cmd}`);
    }
  }

  // ---------- filling ----------

  private async fillTarget(pageId: number, value: string, tag: TestDataTag, bypassMaxLength: boolean) {
    const target = this.targets.get(pageId);
    if (!target) throw new Error('Click into a field on the page first');
    if (target.frame.isDetached()) throw new Error('That field is gone. Click into a field again.');
    if (target.constraints.type === 'select' && tag.source === 'faker') {
      throw new Error('Pick a value from the dropdown, or use the Boundaries tab for selects');
    }
    this.host.expectTestData(pageId, target.locator.selector, tag);
    const result = await target.frame.evaluate(
      ([v, bypass]) =>
        (window as unknown as { __qaRecorder: { fillField(v: string, o: { bypassMaxLength: boolean }): unknown } })
          .__qaRecorder.fillField(v, { bypassMaxLength: bypass }),
      [value, bypassMaxLength] as const,
    );
    return result as { requested: number; accepted: string; acceptedLength: number; truncated: boolean };
  }

  private cases(c: { [key: string]: unknown }): (TestValue & { kind: string })[] {
    const mode = (c.mode as BvaMode) ?? '2-value';
    const kind = String(c.kind ?? 'number');
    const withPartitions = Boolean(c.partitions);
    const tagged = (list: TestValue[], k: string) => list.map((v) => ({ ...v, kind: k }));
    if (kind === 'suggested') {
      const out = this.safeSuggest(c.constraints as FieldConstraints, mode);
      return out.map((v) => ({ ...v, kind: v.technique === 'equivalence-partitioning' ? 'partition' : 'boundary' }));
    }
    if (kind === 'number') {
      const range = { min: Number(c.min), max: Number(c.max), step: c.step ? Number(c.step) : 1, mode };
      return [
        ...tagged(numberBoundaries(range), 'boundary'),
        ...(withPartitions ? tagged(numberPartitions(range), 'partition') : []),
      ];
    }
    if (kind === 'length') {
      const range = {
        minLength: c.min === '' || c.min === undefined ? 0 : Number(c.min),
        maxLength: Number(c.max),
        mode,
        charset: (c.charset as 'text' | 'digits' | 'email') ?? 'text',
      };
      return [
        ...tagged(lengthBoundaries(range), 'boundary'),
        ...(withPartitions ? tagged(lengthPartitions(range), 'partition') : []),
      ];
    }
    if (kind === 'date') return tagged(dateBoundaries({ min: String(c.min), max: String(c.max), mode }), 'boundary');
    throw new Error(`Unknown range kind ${kind}`);
  }

  // ---------- profiles ----------

  loadProfiles(): Profile[] {
    if (!existsSync(this.profilesPath)) return [];
    try {
      const data = JSON.parse(readFileSync(this.profilesPath, 'utf8')) as { profiles?: Profile[] };
      return Array.isArray(data.profiles) ? data.profiles : [];
    } catch {
      return [];
    }
  }

  private saveProfiles(profiles: Profile[]) {
    mkdirSync(dirname(this.profilesPath), { recursive: true });
    writeFileSync(this.profilesPath, JSON.stringify({ version: 1, profiles }, null, 2));
  }

  private updateProfiles(change: (all: Profile[]) => void): Profile[] {
    const all = this.loadProfiles();
    change(all);
    this.saveProfiles(all);
    return all;
  }

  private addToProfile(pageId: number, name: string, spec: GeneratorSpec): Profile[] {
    if (!name) throw new Error('Name the profile, e.g. "New customer"');
    const target = this.targets.get(pageId);
    if (!target) throw new Error('Click into a field on the page first');
    if (target.element.inClosedShadowDom) throw new Error('Fields inside a closed shadow root cannot be filled automatically');
    this.generator.generate(spec); // validate before saving
    return this.updateProfiles((all) => {
      let profile = all.find((p) => p.name === name);
      if (!profile) {
        profile = { name, createdAt: new Date().toISOString(), url: target.frame.page().url(), fields: [] };
        all.push(profile);
      }
      const field: ProfileField = {
        label: target.label,
        framePath: target.framePath,
        selector: target.locator.selector,
        tag: target.element.tag,
        spec,
      };
      const existing = profile.fields.findIndex(
        (f) => f.selector === field.selector && f.framePath.join('>') === field.framePath.join('>'),
      );
      if (existing >= 0) profile.fields[existing] = field;
      else profile.fields.push(field);
    });
  }

  async applyProfile(page: Page, name: string) {
    const profile = this.loadProfiles().find((p) => p.name === name);
    if (!profile) throw new Error(`No profile named "${name}"`);
    const pageId = this.host.pageIdOf(page);
    const filled: { label: string; value: string }[] = [];
    const errors: string[] = [];
    for (const field of profile.fields) {
      try {
        const value = this.generator.generate(field.spec);
        const tag: TestDataTag = {
          source: 'profile', technique: 'random-testing', label: `${profile.name}: ${this.generator.label(field.spec)}`, spec: field.spec,
        };
        this.host.expectTestData(pageId, field.selector, tag);
        const locator = scopeFor(page, field.framePath).locator(field.selector);
        await this.setLocatorValue(locator, field.tag, value);
        filled.push({ label: field.label, value });
      } catch (error) {
        errors.push(`${field.label}: ${(error as Error).message.split('\n')[0]}`);
      }
    }
    return { filled, errors };
  }

  private async setLocatorValue(locator: PwLocator, tag: string, value: string) {
    if (tag === 'select') await locator.selectOption(value, { timeout: 5_000 });
    else await locator.fill(value, { timeout: 5_000 });
  }

  // ---------- looper ----------

  private captureState() {
    if (!this.capture) return { state: 'idle' as const };
    const steps = this.capturedSteps();
    return {
      state: this.capture.endSeq === undefined ? ('capturing' as const) : ('captured' as const),
      url: this.capture.url,
      steps: steps.map((a) => ({
        seq: a.seq,
        action: a.action,
        target: a.element.accessibleName || a.element.text || a.locator.code,
        locator: a.locator.code,
        value: a.value ?? a.labels?.join(', '),
        sensitive: a.sensitive,
        replayable: !a.element.inClosedShadowDom && !(a.sensitive && a.value === '********') && a.action !== 'setInputFiles',
        spec: a.testData?.spec,
      })),
    };
  }

  private capturedSteps(): ActionEvent[] {
    if (!this.capture) return [];
    const { pageId, startSeq, endSeq } = this.capture;
    const end = endSeq ?? Infinity;
    return this.host.actions().filter((a) => a.pageId === pageId && a.seq > startSeq && a.seq <= end && !a.loop);
  }

  private captureStart(page: Page) {
    if (this.running) throw new Error('A loop is running');
    this.capture = { pageId: this.host.pageIdOf(page), startSeq: this.host.lastSeq(), url: page.url() };
    this.host.pushLoopEvent({ pageId: this.capture.pageId, phase: 'capture-start' });
    return this.captureState();
  }

  private captureEnd() {
    if (!this.capture) throw new Error('Start capturing first');
    this.capture.endSeq = this.host.lastSeq();
    const steps = this.capturedSteps();
    if (!steps.length) {
      this.capture = undefined;
      throw new Error('Nothing was captured. Start again and do the flow once.');
    }
    this.host.pushLoopEvent({ pageId: this.capture.pageId, phase: 'capture-end', steps: steps.length });
    return this.captureState();
  }

  /** Replays the captured flow `iterations` times, generating fresh values for chosen fields. */
  async runLoop(options: LoopRunOptions, onStatus: (status: unknown) => void = () => undefined) {
    if (!this.capture || this.capture.endSeq === undefined) throw new Error('Capture a flow first');
    if (this.running) throw new Error('A loop is already running');
    const iterations = Math.max(1, Math.min(Math.floor(options.iterations || 1), 1000));
    const page = this.host.pageById(this.capture.pageId);
    if (!page || page.isClosed()) throw new Error('The tab where the flow was captured is closed');
    const steps = this.capturedSteps();
    const runId = this.nextRunId++;
    const run = { runId, stop: false };
    this.running = run;
    const results: { iteration: number; ok: boolean; error?: string; values: Record<string, string> }[] = [];
    const pageId = this.capture.pageId;
    this.host.pushLoopEvent({ pageId, phase: 'run-start', runId, total: iterations, steps: steps.length });

    try {
      for (let i = 1; i <= iterations && !run.stop; i++) {
        onStatus({ state: 'running', iteration: i, total: iterations });
        this.host.setLoopContext({ runId, iteration: i });
        const values: Record<string, string> = {};
        try {
          if (options.reload && i > 1) await page.goto(this.capture.url, { waitUntil: 'load' });
          for (const step of steps) {
            if (run.stop) break;
            values[step.seq] = await this.replayStep(page, pageId, step, options.values?.[step.seq], i);
          }
          await this.host.waitForApiIdle(5_000);
          results.push({ iteration: i, ok: true, values });
          this.host.pushLoopEvent({ pageId, phase: 'iteration', runId, iteration: i, total: iterations });
        } catch (error) {
          const message = (error as Error).message.split('\n')[0];
          results.push({ iteration: i, ok: false, error: message, values });
          this.host.pushLoopEvent({ pageId, phase: 'iteration', runId, iteration: i, total: iterations, error: message });
        } finally {
          this.host.setLoopContext(undefined);
        }
        if (i < iterations && options.delayMs) await page.waitForTimeout(options.delayMs);
      }
    } finally {
      this.running = undefined;
      const passed = results.filter((r) => r.ok).length;
      this.host.pushLoopEvent({ pageId, phase: 'run-end', runId, total: iterations, passed, stopped: run.stop });
      onStatus({ state: 'done', passed, total: results.length, stopped: run.stop });
    }
    return { runId, results };
  }

  private async replayStep(page: Page, pageId: number, step: ActionEvent, choice: StepValue | undefined, iteration: number) {
    if (step.element.inClosedShadowDom) return ''; // cannot be located; skipped
    const locator = scopeFor(page, step.framePath).locator(step.locator.selector);
    const options = { timeout: 10_000 };
    switch (step.action) {
      case 'click':
        await locator.click({ ...options, button: step.button, modifiers: step.modifiers as never });
        return '';
      case 'dblclick':
        await locator.dblclick(options);
        return '';
      case 'check':
        await locator.check(options);
        return '';
      case 'uncheck':
        await locator.uncheck(options);
        return '';
      case 'press':
        await locator.press(step.key ?? 'Enter', options);
        return '';
      case 'select': {
        const value = this.valueFor(step, choice, iteration) ?? step.values?.[0] ?? '';
        if (choice?.mode === 'generate') this.tag(pageId, step, choice.spec);
        await locator.selectOption(step.values && !choice ? step.values : value, options);
        return value;
      }
      case 'fill': {
        if (step.sensitive && step.value === '********' && choice?.mode !== 'generate') {
          throw new Error(`Step ${step.seq} is a masked password. Pick a generator for it or record with --keep-secrets.`);
        }
        const value = this.valueFor(step, choice, iteration) ?? step.value ?? '';
        const spec = choice?.mode === 'generate' ? choice.spec : choice?.mode === 'keep' ? undefined : step.testData?.spec;
        if (spec) this.tag(pageId, step, spec);
        await locator.fill(value, options);
        return value;
      }
      default:
        return '';
    }
  }

  private valueFor(step: ActionEvent, choice: StepValue | undefined, iteration: number): string | undefined {
    if (choice?.mode === 'keep') return undefined;
    const spec = choice?.mode === 'generate' ? choice.spec : step.testData?.spec;
    return spec ? this.generator.generate(spec, iteration) : undefined;
  }

  private tag(pageId: number, step: ActionEvent, spec: GeneratorSpec) {
    this.host.expectTestData(pageId, step.locator.selector, {
      source: 'loop', technique: 'random-testing', label: this.generator.label(spec), spec,
    });
  }
}
