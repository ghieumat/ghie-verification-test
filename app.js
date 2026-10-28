'use strict';
// GhIE–UMaT TEST frontend. Backend protocol, token handling, sender validation and
// per-operation replay identity are deliberately unchanged from the approved hotfix.
const el=id=>document.getElementById(id);
const config=window.GHIE_CONFIG||{};
const regions=['Ahafo','Ashanti','Bono','Bono East','Central','Eastern','Greater Accra','North East','Northern','Oti','Savannah','Upper East','Upper West','Volta','Western','Western North','Outside Ghana'];
const fields={surname:'Surname',givenNames:'First & other names',referenceNumber:'Student reference number',institution:'Institution',program:'Programme of study',academicLevel:'Academic level',admissionYear:'Admission year',gender:'Gender',email:'Email',phone:'Phone (call/SMS)',whatsapp:'WhatsApp phone'};
let credential=null,account=null,admin=false,busy=false,recordOffset=0,pendingOffset=0;
const pendingActions=new Map();
const timings=[]; // Local timing observations only: no tokens, names or payloads.
window.GHIE_TIMINGS=timings;
let busyControls=[];
const REQUEST_TIMEOUT_MS=25000; // Approved backend timeout remains unchanged.
let activeRequest=null;
function showResumeNotice(message){
 const panel=el('resumeNotice');if(!panel)return;
 el('resumeMessage').textContent=message;
 hide('resumeNotice',false);
}
function recoverStaleRequest(reason,force=false){
 if(typeof document!=='undefined'&&document.visibilityState==='hidden')return;
 const request=activeRequest;
 if(request){
  const elapsed=Date.now()-request.startedWall;
  if(force||elapsed>=REQUEST_TIMEOUT_MS){
   request.interrupt(); // Only cancels local waiting, never replays a server mutation.
   if(!['confirm','correct','review'].includes(request.op))showResumeNotice('The previous request may have been interrupted while your browser was inactive. You can try loading your record again or sign in again.');
  }
 }else if(busy){
  // Defensive recovery for an orphaned spinner; ordinary send() always has activeRequest.
  busy=false;hide('activity');lockControls(false);
  showResumeNotice('The previous loading state was interrupted. You can try loading again or sign in again.');
 }
}
function handlePageReturn(event){
 if(event?.persisted)recoverStaleRequest('back-forward cache',true);
 else recoverStaleRequest('pageshow');
}
function handleVisibilityChange(){
 if(document.visibilityState==='hidden')return;
 recoverStaleRequest('visible');
}
function handlePageResume(){recoverStaleRequest('resume');}

function uuid(){return crypto.randomUUID().replaceAll('-','');}
function esc(s){return String(s??'');}
function node(tag,txt,cls){const e=document.createElement(tag);if(txt!==undefined)e.textContent=esc(txt);if(cls)e.className=cls;return e;}
function hide(id,yes=true){if(typeof document.getElementById!=='function')return;const target=el(id);if(target?.classList){if(typeof target.classList.toggle==='function')target.classList.toggle('hide',yes);else if(yes)target.classList.add('hide');else target.classList.remove('hide');}}
function intentFor(op,data){const previous=pendingActions.get(op);if(previous){if(JSON.stringify(previous.data)!==JSON.stringify(data))throw Error('A previous '+op+' request has an uncertain outcome. Retry the same request before changing its values.');return previous;}const intent={operationId:uuid(),data:JSON.parse(JSON.stringify(data))};pendingActions.set(op,intent);return intent;}
function isUncertain(err){return /timed out|interrupted|connection|network|backend deployment/i.test(String(err.message||''));}
function timeNow(){return typeof performance!=='undefined'&&performance.now?performance.now():Date.now();}
function observe(op,started,outcome){const ms=Math.round(timeNow()-started);timings.push({operation:op,milliseconds:ms,outcome});if(timings.length>30)timings.shift();if(typeof location!=='undefined'&&new URLSearchParams(location.search).has('timing'))console.info('[GhIE timing]',op,ms+'ms',outcome);}
function lockControls(locked){
 if(locked){busyControls=[];if(document.querySelectorAll)document.querySelectorAll('#main button,#main input,#main select').forEach(c=>{busyControls.push([c,c.disabled]);c.disabled=true;});if(document.body)document.body.classList.add('is-requesting');}
 else{for(const [c,wasDisabled] of busyControls)if(c.isConnected)c.disabled=wasDisabled;busyControls=[];if(document.body)document.body.classList.remove('is-requesting');}
}
function activityFor(op){
 const labels={mine:'Retrieving your information…',confirm:'Submitting your verification...',correct:'Submitting your correction request...',review:'Submitting the administrator decision...',adminList:'Loading dashboard records…',photo:'Retrieving your private photograph…'};
 if(el('activityText'))el('activityText').textContent=labels[op]||'Processing your request…';
 if(el('activityHint'))el('activityHint').textContent='Please keep this page open.';
 hide('activity',false);lockControls(true);
}
function alertUI(message,error=false){
 const profileVisible=!el('profile').classList.contains('hide');
 const n=el(profileVisible?'notice':'appFeedback');n.textContent=message;n.classList.toggle('error',error);n.classList.remove('hide');
 // Only one copy of a message is announced to assistive technologies.
 hide(profileVisible?'appFeedback':'notice');
}
function feedback(kind,message,scope='student'){
 if(typeof document.getElementById!=='function'||!el('submissionFeedback'))return;
 const f=(scope==='admin'||(admin&&el('profile').classList.contains('hide')))?el('adminFeedback'):el('submissionFeedback');f.className='submission-feedback '+kind;f.replaceChildren();
 const symbol=node('span',kind==='success'?'✓':kind==='uncertain'?'!':'i','feedback-symbol');symbol.setAttribute('aria-hidden','true');
 const txt=node('span',message,'feedback-copy');f.append(symbol,txt);hide('submissionFeedback',false);
}
function clearFeedback(){hide('submissionFeedback');hide('adminFeedback');hide('uncertainActions');hide('adminUncertainActions');}
function uncertainFeedback(op){
 if(typeof document.getElementById!=='function'||!el('uncertainDetail'))return;
 const isReview=op==='review';
 feedback('uncertain',"We couldn't confirm whether your submission was completed. Please check its status before trying again.",isReview?'admin':'student');
 const detail='Checking the latest record does not establish whether this specific request finished. Retrying safely reuses the original operation ID and unchanged details.';
 el(isReview?'adminUncertainDetail':'uncertainDetail').textContent=detail;
 hide(isReview?'adminUncertainActions':'uncertainActions',false);
 el(isReview?'adminRetryPending':'retryPending').dataset.op=op;
}
function updateStatus(status){
 const badge=el('verificationStatus'),strip=badge.closest('.status-strip');
 strip.classList.remove('is-ready','is-pending');
 if(status.pending?.length){badge.textContent='Correction pending review';strip.classList.add('is-pending');}
 else if(status.ready){badge.textContent='Verified · Registration-ready';strip.classList.add('is-ready');}
 else if(status.issue){badge.textContent='Action required';strip.classList.add('is-pending');}
 else if(status.confirmed){badge.textContent='Confirmation recorded';strip.classList.add('is-ready');}
 else badge.textContent='Awaiting confirmation';
 el('confirm').disabled=busy||!!status.pending?.length;
 const timeline=el('correctionTimeline');timeline.replaceChildren();
 if(status.pending?.length){
  const heading=node('strong','Pending administrator review');timeline.append(heading);
  const description=node('p','Your correction has been submitted. It has not yet been approved or rejected.');timeline.append(description);
  const list=node('ul');status.pending.forEach(p=>{const item=node('li',`${fields[p.field]||'Field'} — Pending review`);list.append(item);});timeline.append(list);hide('correctionTimeline',false);
 }else hide('correctionTimeline');
}
function render(data){
 account=data;admin=!!data.admin;document.body.classList.add('signed-in');hide('loadingView');hide('login');hide('profile',!!data.adminOnly);hide('admin',!admin);
 if(data.adminOnly){el('summary').textContent='Administrator access enabled. No student registration record is required.';return;}
 const status=data.status,e=status.effective||data.record;
 const area=el('details');area.replaceChildren();for(const [key,label] of Object.entries(fields)){
  const item=node('div',undefined,'detail');if(key==='referenceNumber'&&!/^\d+$/.test(String(e[key]||'')))item.classList.add('ref-alert');
  item.append(node('small',label),node('strong',e[key]||'—'));area.appendChild(item);
 }
 el('region').value=status.region||'';el('country').value=status.country||'';el('province').value=status.province||'';outside();updateStatus(status);
 if(status.pending?.length)alertUI(`${status.pending.length} correction(s) are pending administrator review.`);
 else if(status.ready)alertUI('Your information is verified and ready for registration preparation.');
 else if(status.issue)alertUI('Action needed: '+status.issue);
 else if(status.confirmed)alertUI('Your confirmation is recorded.');
 else alertUI('Review every field carefully, select your Region of Origin, then confirm or request a correction.');
 const photo=el('photo');photo.replaceChildren();if(data.record.hasPhoto){
  photo.append(node('span','Photograph on file · '));const button=node('button','View private photograph','button-secondary');button.type='button';
  button.onclick=async()=>{try{const p=await send('photo');const img=document.createElement('img');img.alt='Your registration photograph';img.src=`data:${p.mime};base64,${p.data}`;photo.replaceChildren(img);}catch(err){alertUI(err.message,true);}};
  photo.append(button);
 }
}
// In the approved transport the Apps Script HTML response is a descendant of the form's iframe.
function isBridgeDescendant(source,bridge){if(!source||!bridge)return false;try{for(let depth=0;depth<8;depth++){if(source===bridge)return true;const parent=source.parent;if(!parent||parent===source)return false;source=parent;}}catch(_){return false;}return false;}
function isExpectedBridgeResponse(event,nonce){
 if(!isBridgeDescendant(event.source,el('bridge').contentWindow))return false;
 if(typeof event.origin!=='string'||!/^https:\/\/(?:[a-z0-9-]+-)?script\.googleusercontent\.com$/i.test(event.origin))return false;
 const v=event.data;return !!(v&&typeof v==='object'&&!Array.isArray(v)&&v.nonce===nonce&&typeof v.ok==='boolean');
}
function send(op,payload={}){
 if(!credential)return Promise.reject(Error('Please sign in again'));
 if(busy)return Promise.reject(Error('Finish the current request first'));
 const nonce=uuid(),transport=el('transport');
 if(!config.endpoint||!config.endpoint.startsWith('https://script.google.com/macros/s/'))return Promise.reject(Error('Invalid backend configuration'));
 const started=timeNow();
 return new Promise((resolve,reject)=>{
  let settled=false;
  const request={op,startedWall:Date.now(),interrupt:()=>finish('interrupted',null,Error('Request interrupted after browser suspension. Please check its status before trying again.'))};
  activeRequest=request;
  busy=true;activityFor(op);
  const slow=setTimeout(()=>{if(!settled&&el('activityHint'))el('activityHint').textContent='The TEST Google service is taking longer than usual. Your request is still processing.';},6500);
  const later=setTimeout(()=>{if(!settled&&el('activityHint'))el('activityHint').textContent='Still waiting for the backend. Do not submit the action again yet.';},16000);
  const timer=setTimeout(()=>finish('timeout',null,Error('Request timed out. Check your connection or backend deployment.')),REQUEST_TIMEOUT_MS);
  function finish(outcome,value,error){
   if(settled)return;
   settled=true;
   clearTimeout(timer);clearTimeout(slow);clearTimeout(later);
   window.removeEventListener('message',onMsg);
   if(activeRequest===request)activeRequest=null;
   busy=false;hide('activity');lockControls(false);observe(op,started,outcome);
   if(error)reject(error);else resolve(value);
  }
  function onMsg(event){
   if(!isExpectedBridgeResponse(event,nonce))return;
   const v=event.data;finish(v.ok?'ack':'error',v.value,v.ok?null:Error(v.error||'Request failed'));
  }
  window.addEventListener('message',onMsg);
  try{transport.action=config.endpoint;el('payload').value=JSON.stringify({op,token:credential,nonce,...payload});transport.submit();}
  catch(_){finish('transport-error',null,Error('Network or backend deployment error'));}
 });
}
async function reload({preserveFeedback=false}={}){
 const data=await send('mine');render(data);hide('resumeNotice');if(admin)await loadAdmin();
 if(!preserveFeedback)clearFeedback();
 return data;
}
async function loadSignedInRecord(){
 hide('resumeNotice');hide('login');hide('loadingView',false);
 try{await reload();hide('resumeNotice');}
 catch(err){
  hide('loadingView');hide('profile');hide('admin');hide('login',false);
  document.body.classList.remove('signed-in');account=null;admin=false;
  if(isUncertain(err)&&credential){
   showResumeNotice('We could not finish loading your information. Try loading again, or sign in again. No verification or correction was submitted.');
  }else{
   credential=null;showResumeNotice('The current sign-in could not be verified. Please sign in again.');
  }
  alertUI('Unable to load the verified record. '+err.message,true);
 }
}
async function handleAuth(response){
 if(busy){recoverStaleRequest('Google sign-in');if(busy)return;}
 pendingActions.clear();clearFeedback();credential=response.credential;
 await loadSignedInRecord();
}
function outside(){const outsideGhana=el('region').value==='Outside Ghana';hide('outside',!outsideGhana);el('country').required=outsideGhana;}
async function operate(op,data){
 if(busy)return null; // The active request already owns the UI and operation ID.
 let intent;
 try{
  intent=intentFor(op,data);
  const result=await send(op,{operationId:intent.operationId,...intent.data});
  pendingActions.delete(op);hide('uncertainActions');hide('adminUncertainActions');
  // Ack is the authoritative success event. Avoid a second read request on the
  // student path; a slow refresh must never conceal an already-acknowledged write.
  if(op==='confirm'){
   if(account&&!account.adminOnly)render({...account,status:result.status});
   feedback('success','Your information has been successfully confirmed.');
  }else if(op==='correct'){
   if(account&&!account.adminOnly){const pending=[...(account.status.pending||[]),{id:result.requestId,field:intent.data.field}];account.status={...account.status,pending,ready:false};updateStatus(account.status);alertUI('Your correction is pending administrator review.');}
   feedback('success','Your correction request has been submitted successfully and is awaiting administrator review.');
  }else if(op==='review'){
   feedback('success',`The correction has been ${result.decision==='APPROVED'?'approved':'rejected'} successfully.`,'admin');
   try{await loadAdmin();}catch(_){/* The approval ACK must remain visible. */}
  }
  return result;
 }catch(err){
  if(intent&&!isUncertain(err))pendingActions.delete(op);
  if(intent&&isUncertain(err))uncertainFeedback(op);
  else feedback('error',err.message||'Submission failed.',op==='review'?'admin':'student');
  return null;
 }
}
async function checkStatus(){
 try{await reload({preserveFeedback:true});
  if(pendingActions.size){for(const id of ['uncertainDetail','adminUncertainDetail'])el(id).textContent='Latest record loaded. This read does not confirm the outcome of the timed-out operation. Use Safe retry to resolve that specific request.';}
  else feedback('info','The latest verification status was loaded.');
 }catch(err){feedback('error','Unable to retrieve the latest status. '+err.message);}
}
async function retryPending(op=el('retryPending').dataset.op){const intent=pendingActions.get(op);if(!intent)return feedback('info','No uncertain operation remains.');await operate(op,intent.data);}
async function loadAdmin(){
 if(!admin)return;
 try{const res=await send('adminList',{query:el('search').value,offset:recordOffset,pendingOffset});
  el('summary').textContent=`Records ${res.total?res.offset+1:0}–${res.offset+res.records.length} of ${res.total}; pending corrections ${res.totalPending?res.pendingOffset+1:0}–${res.pendingOffset+res.pending.length} of ${res.totalPending}.`;
  el('metricRecords').textContent=String(res.total);el('metricPending').textContent=String(res.totalPending);
  el('metricReady').textContent=String(res.records.filter(x=>x.ready).length);
  el('recordPageInfo').textContent=`${res.total?res.offset+1:0}–${res.offset+res.records.length} of ${res.total}`;
  el('pendingPageInfo').textContent=`${res.totalPending?res.pendingOffset+1:0}–${res.pendingOffset+res.pending.length} of ${res.totalPending}`;
  el('prevRecords').disabled=recordOffset===0;el('nextRecords').disabled=recordOffset+res.records.length>=res.total;
  el('prevPending').disabled=pendingOffset===0;el('nextPending').disabled=pendingOffset+res.pending.length>=res.totalPending;
  const pend=el('pending');pend.replaceChildren();if(!res.pending.length)pend.append(node('p','No pending corrections.'));
  res.pending.forEach(x=>{const box=node('div',undefined,'request');box.append(node('strong',fields[x.field]||x.field),node('p',`Original: ${x.original}`),node('p',`Proposed: ${x.proposed}`),node('small',`Request ID: ${x.id}`));
   const actions=node('div',undefined,'actions');for(const decision of ['APPROVED','REJECTED']){const b=node('button',decision==='APPROVED'?'Approve':'Reject',decision==='REJECTED'?'button-secondary button-danger':'button-primary');b.type='button';b.onclick=async()=>{if(!window.confirm(`${decision==='APPROVED'?'Approve':'Reject'} this correction?`))return;const reason=window.prompt('Decision reason (optional):')||'';await operate('review',{requestId:x.id,decision,reason});};actions.append(b);}box.append(actions);pend.append(box);});
  const rec=el('records');rec.replaceChildren();res.records.forEach(x=>{const line=node('div',undefined,'record'),info=node('div',undefined,'record-info');info.append(node('strong',x.name),node('small',`${x.referenceNumber} · ${x.program} · ${x.level}`));line.append(info,node('span',x.ready?'REGISTRATION-READY':x.issue||'Not ready','pill '+(x.ready?'is-ready':'is-warning')));rec.append(line);});
 }catch(err){alertUI(err.message,true);throw err;}
}
document.addEventListener('DOMContentLoaded',()=>{
 window.addEventListener('pageshow',handlePageReturn);
 document.addEventListener('visibilitychange',handleVisibilityChange);
 document.addEventListener('resume',handlePageResume);
 if(document.wasDiscarded)showResumeNotice('Your browser unloaded this tab while it was inactive. Sign in and check your current status before submitting anything again.');
 el('resumeReload').onclick=()=>{
  if(busy)return;
  if(!credential)return showResumeNotice('Your previous sign-in is no longer available. Please sign in again.');
  loadSignedInRecord(); // READ ONLY: never automatically retry a write operation.
 };
 regions.forEach(x=>el('region').add(new Option(x,x)));
 Object.entries(fields).forEach(([id,label])=>el('field').add(new Option(label,id)));
 el('region').addEventListener('change',outside);
 el('toggleCorrection').onclick=()=>{const open=el('correction').classList.contains('hide');hide('correction',!open);el('toggleCorrection').setAttribute('aria-expanded',String(open));};
 el('confirm').onclick=()=>{if(!window.confirm('Confirm that your information is correct?'))return;operate('confirm',{region:el('region').value,country:el('country').value,province:el('province').value});};
 el('sendCorrection').onclick=async()=>{const v=el('newValue').value.trim();if(!v)return feedback('error','Enter the proposed correct value.');const r=await operate('correct',{field:el('field').value,value:v});if(r){hide('correction');el('toggleCorrection').setAttribute('aria-expanded','false');el('newValue').value='';}};
 el('checkStatus').onclick=checkStatus;el('retryPending').onclick=()=>retryPending();
 el('adminCheckStatus').onclick=checkStatus;el('adminRetryPending').onclick=()=>retryPending(el('adminRetryPending').dataset.op);
 const signOut=()=>{if(busy)return;credential=null;account=null;admin=false;pendingActions.clear();clearFeedback();hide('loadingView');hide('profile');hide('admin');hide('login',false);hide('resumeNotice');hide('appFeedback');hide('notice');document.body.classList.remove('signed-in');el('details').replaceChildren();if(window.google?.accounts?.id)google.accounts.id.disableAutoSelect();};
 el('signout').onclick=signOut;el('signoutAdmin').onclick=signOut;el('resumeSignIn').onclick=signOut;
 el('refreshAdmin').onclick=loadAdmin;
 for(const [id,dimension,delta] of [['prevRecords','records',-25],['nextRecords','records',25],['prevPending','pending',-25],['nextPending','pending',25]])el(id).onclick=()=>{if(dimension==='records')recordOffset=Math.max(0,recordOffset+delta);else pendingOffset=Math.max(0,pendingOffset+delta);loadAdmin();};
 let searchTimer;el('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{if(busy)return;recordOffset=0;pendingOffset=0;loadAdmin();},500);};
 const init=()=>{if(!window.google?.accounts?.id){setTimeout(init,250);return;}if(!config.googleClientId||config.googleClientId.startsWith('REPLACE')){el('signin').textContent='Configure Google Client ID in config.js before deployment.';return;}google.accounts.id.initialize({client_id:config.googleClientId,callback:handleAuth,auto_select:false});google.accounts.id.renderButton(el('signin'),{theme:'outline',size:'large',text:'signin_with',width:260});};init();
});
