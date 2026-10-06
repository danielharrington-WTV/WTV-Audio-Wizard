// Panel-only preferences; these fields must not enter the service's DSP schema.
function createDialogueSelector({document, musicPass, storage, getContext, onError}) {
  const $=id=>document.getElementById(id);
  let busy=false, revision=0, boxes=[];
  const current=()=>musicPass.loadReference(storage,getContext());
  function setBusy(value) {
    busy=value;
    if(value) revision++;
    const context=getContext(), disabled=busy || !context?.applied || context.failedApply;
    $('duckAgainst').disabled=Boolean(disabled);
    $('refreshDialogueTracks').disabled=Boolean(disabled);
    boxes.forEach(box=>{box.disabled=Boolean(disabled);});
  }
  async function refresh({summaryOnly=false}={}) {
    const ticket=++revision, context=getContext(), choice=current();
    if (!summaryOnly) {
      $('duckAgainst').value=choice.mode;
      $('dialogueTrackList').style.display=choice.mode==='tracks' ? 'block' : 'none';
      $('dialogueTrackList').textContent=''; boxes=[];
      $('musicReference').style.display=context?.applied ? 'block' : 'none';
      setBusy(busy);
    }
    if(busy || !context?.applied || context.failedApply) return;
    if (!summaryOnly) $('dialogueReferenceSummary').textContent='Reading dialogue tracks…';
    try {
      const ref=await musicPass.reference(context,choice);
      if(ticket!==revision || context!==getContext() || busy) return;
      $('dialogueReferenceSummary').textContent=ref.error || ref.label;
      if(summaryOnly || choice.mode!=='tracks') return;
      function addTrack(key,label,disabled=false) {
        const row=document.createElement('label'), box=document.createElement('input');
        row.className='track-check';
        box.type='checkbox'; box.checked=choice.trackIds.includes(key); box.disabled=disabled;
        const name=document.createElement('span'); name.textContent=label;
        row.appendChild(box); row.appendChild(name); $('dialogueTrackList').appendChild(row); boxes.push(box);
        box.addEventListener('change',()=>{
          if(busy || context!==getContext()) return;
          const next=current();
          next.trackIds=next.trackIds.filter(id=>id!==key);
          if(box.checked) next.trackIds.push(key);
          // Keep rows, focus and scroll position intact while updating selection.
          save(next,{summaryOnly:true});
        });
      }
      ref.tracks.forEach(track=>addTrack(track.id,track.label+(track.muted ? ' (muted)' : ''),track.id===null));
      // Leave stale choices visible and removable instead of silently selecting
      // whichever track now occupies the same position.
      choice.trackIds.filter(key=>!ref.tracks.some(t=>t.id===key)).forEach(key=>addTrack(key,'Unavailable track · uncheck to remove'));
    } catch(error) {
      if(ticket===revision && context===getContext() && !busy) $('dialogueReferenceSummary').textContent=error.message;
    }
  }
  function save(choice,options) {
    try { musicPass.saveReference(storage,getContext(),choice); void refresh(options); }
    catch(error) { onError(error); }
  }
  $('duckAgainst').value='clean';
  $('duckAgainst').addEventListener('change',()=>{
    if(busy || !getContext()?.applied) return;
    save({...current(),mode:$('duckAgainst').value});
  });
  $('refreshDialogueTracks').addEventListener('click',()=>{if(!busy) void refresh();});
  return {refresh,setBusy,current};
}
module.exports={createDialogueSelector};
