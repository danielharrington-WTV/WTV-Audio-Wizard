const ppro = require('premierepro');
const time = seconds => ppro.TickTime.createWithSeconds(seconds);

// Adobe's own ComponentParam.getValueAtTime() docs say this can resolve to
// number | string | boolean | PointF | Color depending on the param's
// underlying type. Confirmed live, in order, for Amplify's Left/Right: it
// first needed numeric-string coercion, then turned out to actually come
// back as a boxed {value: <number>} object -- a marshalling shape absent
// from Adobe's own documented union (see the "ComponentParam value-
// marshalling defects" pattern other UXP developers have hit on other param
// types). Both are unwrapped to a plain number here; anything else
// (boolean/PointF/Color, or a non-numeric string/object) is genuinely not a
// usable gain value, and this returns NaN so callers can tell the two cases
// apart with a plain Number.isFinite() check. Used both when reading the
// initial base value (configure()) AND when reading a value back after
// writing it (verify()) -- it is the same live representation quirk either
// time, and only one of those two call sites had this fix at first.
function coerceGainValue(raw) {
  if(typeof raw==='number') return raw;
  if(typeof raw==='string' && raw.trim()!=='' && Number.isFinite(Number(raw))) return Number(raw);
  if(raw && typeof raw==='object' && Number.isFinite(raw.value)) return raw.value;
  return NaN;
}

// First point strictly after t. Both lookup and clip slicing avoid rescanning
// the entire global envelope for each short music clip.
function upperBound(points, t) {
  let lo=0, hi=points.length;
  while(lo<hi) {const mid=(lo+hi)>>>1;if(points[mid][0]<=t) lo=mid+1;else hi=mid;}
  return lo;
}
function valueAt(points, t) {
  const i=upperBound(points,t);
  if(!i) return points[0][1];
  if(i===points.length) return points[i-1][1];
  const [a,x]=points[i-1], [b,y]=points[i];
  return x+(y-x)*(t-a)/(b-a);
}

function clipCurve(points, clip, rate) {
  const end=Math.max(clip.start,clip.end-1/rate);
  const curve=[[clip.inPoint,valueAt(points,clip.start)]];
  for(let i=upperBound(points,clip.start); i<points.length && points[i][0]<end; i++) {
    curve.push([clip.inPoint+points[i][0]-clip.start,points[i][1]]);
  }
  if(end>clip.start) curve.push([clip.inPoint+end-clip.start,valueAt(points,end)]);
  // Amplify stores (dB+96)/144. Linear interpolation of this affine
  // encoding is exactly linear in dB: intermediate gain-step keys add no
  // information. Preserve every service corner and both clipped endpoints.
  return curve;
}

function fitClipCurve(points, clip, rate, maxKeys) {
  const curve=clipCurve(points,clip,rate);
  if(curve.length>maxKeys) throw Error(`Too many duck curve corners for "${clip.name || 'music clip'}" (${curve.length}, limit ${maxKeys}). Use shorter music clips.`);
  const legacyKeyCount=curve.slice(1).reduce((n,p,i)=>n+Math.max(1,Math.ceil(Math.abs(p[1]-curve[i][1])/.25)),1);
  return {curve,legacyKeyCount,interpolation:'linear_db_corners'};
}

async function snapshot(chain) {
  const components=[];
  for(let i=0;i<await chain.getComponentCount();i++) {
    const component=await chain.getComponentAtIndex(i), params=[];
    for(let j=0;j<await component.getParamCount();j++) {
      const param=await component.getParam(j);
      const varying=await param.isTimeVarying();
      const times=varying ? (await param.getKeyframeListAsTickTimes()).filter(t => t && t.ticks != null) : [time(0)];
      if(times.length>20000) throw Error('Too many existing music keyframes to verify safely.');
      const values=[];
      for(const t of times) {
        if (!t || t.ticks == null) continue;
        values.push([t.ticks,await param.getValueAtTime(t), varying ? await param.getKeyframePtr(t).getTemporalInterpolationMode() : null]);
      }
      params.push([param.displayName,varying,values]);
    }
    components.push([await component.getMatchName(),params]);
  }
  return JSON.stringify(components);
}

// Creates the native Amplify component via the factory, but does NOT touch
// its parameters yet. A component returned directly by
// AudioFilterFactory.createComponentByDisplayName() is an AudioFilterComponent
// handle -- Premiere's own type declarations document it with zero methods
// (unlike the Component type returned by AudioComponentChain.getComponentAtIndex(),
// which has getParamCount()/getParam()). Confirmed live in Premiere: calling
// component.getParamCount() on this raw handle throws
// "component.getParamCount is not a function". The component only becomes a
// full Component (with working getParamCount/getParam) once it has actually
// been appended into the clip's chain via a committed transaction -- see
// installed() below.
async function createComponent(clip, catalog = {}) {
  const factory=ppro.AudioFilterFactory;
  if (!factory || typeof factory.createComponentByDisplayName !== 'function') throw Error('This Premiere build cannot create native audio effects.');
  if (!catalog.amplify) catalog.amplify=(await factory.getDisplayNames()).find(n=>n.toLowerCase()==='amplify');
  const name=catalog.amplify;
  if(!name) throw Error('Native Amplify effect not found. Copy report with your Premiere language/version.');
  return {component: await factory.createComponentByDisplayName(name,clip.item), clip};
}

// Re-fetches the just-appended component from the live chain as a proper
// Component object. Must be called only after a transaction that appended
// `created.component` into `clip.chain` has already been committed.
async function installed(clip) {
  const chain=clip.chain;
  return chain.getComponentAtIndex(await chain.getComponentCount()-1);
}

// Matches a param display name against every spelling we've seen or expect
// for Amplify's gain control(s) across Premiere versions/localizations
// ("Gain", "Amount", "Amplification", "Level", plain "dB"), PLUS "Left"/
// "Right". Confirmed live in Premiere (real component dump): Amplify is not
// a single-control effect here at all -- it exposes Bypass, Channel Count,
// Link Sliders, Left, Right, Link Keyframes. There is no parameter whose name
// contains "gain"/"amount"/etc; the actual animatable gain controls are the
// per-channel "Left" and "Right" sliders (Link Sliders is just a UI
// convenience toggle, not itself a gain value -- deliberately not matched).
// Both Left and Right are collected into `selected` below and get identical
// duck keyframes, since ducking must reduce every channel equally; on a mono
// source only one of them may be present, which is also handled below.
const isGainLike = name => /\b(left|right)\b/i.test(name || '') || /gain|amount|amplif|level|\bdb\b/i.test(name || '');

// Confirmed live in Premiere's own Effect Controls UI: Left/Right display
// directly in dB, default 0 dB, ranging -96 to +48 dB (a 144 dB span). The
// raw value returned by getValueAtTime()/consumed by createKeyframe() is
// NOT that dB number and NOT a linear amplitude ratio (both were tried and
// both failed -- the amplitude-ratio guess passed client-side validation
// but produced a ~42-54 dB calibration error against real Premiere) -- it
// is the dB value's normalized [0,1] position on this fixed slider range.
// 0 dB normalizes to (0-(-96))/144 = 0.666666..., which is exactly the
// 0.6666666865348816 read back live as a freshly-created Amplify's default
// Left/Right value -- confirming this model.
const AMPLIFY_MIN_DB = -96, AMPLIFY_MAX_DB = 48, AMPLIFY_RANGE_DB = AMPLIFY_MAX_DB - AMPLIFY_MIN_DB;
const dbToNormalized = db => (db - AMPLIFY_MIN_DB) / AMPLIFY_RANGE_DB;
const normalizedToDb = value => value * AMPLIFY_RANGE_DB + AMPLIFY_MIN_DB;

// Reads parameters and builds keyframe objects on an already-installed
// Component (obtained from installed() above, not the raw factory handle).
async function configure(component, clip, points, rate, options = {}) {
  const {curve,legacyKeyCount,interpolation}=fitClipCurve(points,clip,rate,options.maxKeysPerParam || 10000);
  if(curve.length>10000) throw Error('Too many duck keyframes for one music clip. Use a shorter sequence.');
  const candidates=[];
  for(let i=0;i<await component.getParamCount();i++) {
    const param=await component.getParam(i);
    candidates.push({param,index:i,name:param.displayName});
  }
  // Fallback for any Premiere build/locale where Amplify turns out to have
  // exactly one parameter total (unlike the real Left/Right layout confirmed
  // above): with only one candidate to begin with, it must be the gain
  // control under some other name -- use it rather than fail outright.
  let selected=candidates.filter(c=>isGainLike(c.name));
  if(!selected.length && candidates.length===1) selected=candidates;
  if(!selected.length) throw Error(`Could not identify native Amplify gain parameters. Found: ${candidates.map(c=>c.name).join(', ') || 'none'}.`);
  // Every dB value in the requested curve must land on the confirmed
  // -96..+48 dB slider, or the normalized value written below would be
  // outside [0,1] and get silently clamped by Premiere -- the same failure
  // mode that produced the original 42-54 dB calibration error (that one
  // came from a wrong *formula*, not an out-of-range value, but a clamp
  // would look identical from here, so both are guarded the same way now).
  for(const [,db] of curve) if(db<AMPLIFY_MIN_DB || db>AMPLIFY_MAX_DB) throw Error(`Requested music gain ${db.toFixed(1)} dB is outside Amplify's -96..+48 dB range.`);
  const parameters=[];
  for(const {param,index} of selected) {
    if(!await param.areKeyframesSupported()) throw Error(`Amplify parameter cannot be animated: ${param.displayName}`);
    // Sanity-check the live default against the confirmed mapping rather
    // than trusting it blindly a third time: if some other Premiere
    // build/locale's Amplify does not default to 0 dB / this same -96..+48
    // range, this catches it with a specific diagnostic instead of quietly
    // writing values that are wrong by an unknown, possibly huge, amount.
    const rawBase=await param.getValueAtTime(time(0));
    const base=coerceGainValue(rawBase);
    if(!Number.isFinite(base)) throw Error(`Unrecognized Amplify gain representation for "${param.displayName}": ${JSON.stringify(rawBase)} (typeof ${typeof rawBase}). Copy report with this value.`);
    if(Math.abs(base-dbToNormalized(0))>0.01) throw Error(`Amplify "${param.displayName}" default is ${normalizedToDb(base).toFixed(1)} dB, not the expected 0 dB. Its gain range may differ from the confirmed -96..+48 dB; copy report before proceeding.`);
    const encode=dbToNormalized;
    const keys=[];
    // REVERTED 2026-09-09: this loop was briefly wrapped in
    // project.lockedAccess(() => {...}) per Adobe's v26.3.0 changelog
    // ("Action creation in locks"), as a speculative, never-previously-
    // exercised hardening against stale Action data. The very next real
    // Premiere run after that change crashed the entire application --
    // confirmed via Sentry's own crash breadcrumb: a fatal native fault
    // inside Adobe's own scripting bridge (AsyncScriptTaskQueue.cpp,
    // ProcessPromise) while resolving a Promise<boolean>, in this plugin's
    // script context, moments after this code path first ran live. Calling
    // a synchronous "lock" callback from deep inside an async/await chain
    // is a plausible trigger for corrupting the native engine's own
    // promise/microtask queue. A real (if theoretical, never confirmed)
    // crash beats a theoretical staleness bug that was never observed:
    // reverted to creating keyframes directly, unlocked, exactly as this
    // function did throughout all of this session's other fixes before the
    // lockedAccess change -- none of which ever crashed Premiere itself.
    for(const [seconds,db] of curve) {
      const key=param.createKeyframe(encode(db));
      key.position=time(seconds);
      keys.push({key,seconds,value:encode(db)});
    }
    for(const {key} of keys) if(!await key.setTemporalInterpolationMode(ppro.Constants.InterpolationMode.LINEAR)) throw Error('Premiere refused linear gain interpolation.');
    parameters.push({param,keys,index});
  }
  return {component,parameters,clip,curve,legacyKeyCount,interpolation};
}

function addActions(compound, prepared) {
  for(const {param,keys} of prepared.parameters) {
    compound.addAction(param.createSetTimeVaryingAction(true));
    for(const {key} of keys) compound.addAction(param.createAddKeyframeAction(key));
  }
}

async function isAmplifyComponent(component) {
  // Display name and internal match name are distinct Premiere fields.
  // An internal ID need not contain the word shown in Effect Controls.
  if (typeof component.getDisplayName === 'function' &&
      String(await component.getDisplayName()).trim().toLowerCase()==='amplify') return true;
  const match = await component.getMatchName();
  return /amplify/i.test(match || '');
}

async function listAmplifyComponents(chain) {
  const hits = [];
  for (let i = 0; i < await chain.getComponentCount(); i++) {
    const component = await chain.getComponentAtIndex(i);
    if (await isAmplifyComponent(component)) hits.push({ index: i, component });
  }
  return hits;
}

function addRemoveAmplifyActions(compound, chain, amplifies) {
  for (const { component } of [...amplifies].sort((a, b) => b.index - a.index)) {
    compound.addAction(chain.createRemoveComponentAction(component));
  }
}

async function isVolumeComponent(component) {
  const match = await component.getMatchName();
  return /volume/i.test(match || '');
}

async function listVolumeComponents(chain) {
  const hits = [];
  for (let i = 0; i < await chain.getComponentCount(); i++) {
    const component = await chain.getComponentAtIndex(i);
    if (await isVolumeComponent(component)) hits.push({ index: i, component });
  }
  return hits;
}

function addRemoveVolumeActions(compound, chain, volumes) {
  for (const { component } of [...volumes].sort((a, b) => b.index - a.index)) {
    compound.addAction(chain.createRemoveComponentAction(component));
  }
}

function addRestoreVolumeActions(compound, chain, volumes) {
  for (const { component, index } of [...volumes].sort((a, b) => a.index - b.index)) {
    compound.addAction(chain.createInsertComponentAction(component, index));
  }
}

async function verify(prepared) {
  const chain=prepared.clip.chain;
  const installed=await chain.getComponentAtIndex(await chain.getComponentCount()-1);
  if(await installed.getMatchName()!==await prepared.component.getMatchName()) throw Error('Premiere did not install the music effect.');
  prepared.component=installed;
  for(const {index,keys} of prepared.parameters) {
    const param=await installed.getParam(index);
    if(!await param.isTimeVarying()) throw Error('Premiere did not enable music keyframes.');
    const actual=(await param.getKeyframeListAsTickTimes()).filter(t => t && t.ticks != null);
    const ticks=new Set(actual.map(t=>t.ticks));
    for(const {key,value} of keys) {
      if (!key?.position?.ticks) throw Error(`Premiere music keyframe readback failed: missing keyframe position on "${param.displayName}". Save the project and retry the music pass.`);
      // Distinguish "the keyframe was never actually added" (a known,
      // Adobe-confirmed-but-unresolved UXP bug for some track item types --
      // see https://community.adobe.com/questions-729/unable-to-set-mutliple-keyframes-with-uxp-1548880,
      // where createAddKeyframeAction() silently drops all but the last
      // keyframe) from "it was added, but the value read back oddly" (the
      // same {value:<number>}/string marshalling quirk fixed in configure()
      // above -- getValueAtTime() can return that shape here too, not just
      // for the initial base read).
      if(!ticks.has(key.position.ticks)) throw Error(`Premiere music keyframe readback failed: no keyframe at ${key.position.seconds.toFixed(3)}s on "${param.displayName}" (Premiere reports ${actual.length} keyframe(s) total on this parameter). The keyframe may not have been added.`);
      const rawRead=await param.getValueAtTime(key.position);
      const read=coerceGainValue(rawRead);
      if(!Number.isFinite(read) || Math.abs(read-value)>Math.max(1e-5,Math.abs(value)*1e-5)) throw Error(`Premiere music keyframe readback failed: at ${key.position.seconds.toFixed(3)}s on "${param.displayName}", wrote ${value} but read back ${JSON.stringify(rawRead)} (typeof ${typeof rawRead}).`);
      if(await param.getKeyframePtr(key.position).getTemporalInterpolationMode()!==ppro.Constants.InterpolationMode.LINEAR) throw Error(`Premiere did not preserve linear interpolation for the music keyframe at ${key.position.seconds.toFixed(3)}s on "${param.displayName}".`);
    }
  }
}
module.exports={time,valueAt,clipCurve,fitClipCurve,snapshot,createComponent,installed,configure,addActions,verify,isAmplifyComponent,listAmplifyComponents,addRemoveAmplifyActions,isVolumeComponent,listVolumeComponents,addRemoveVolumeActions,addRestoreVolumeActions};
