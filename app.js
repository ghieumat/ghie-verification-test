'use strict';
const el=id=>document.getElementById(id);
const config=window.GHIE_CONFIG||{};
const regions=['Ahafo','Ashanti','Bono','Bono East','Central','Eastern','Greater Accra','North East','Northern','Oti','Savannah','Upper East','Upper West','Volta','Western','Western North','Outside Ghana'];
const fields={surname:'Surname',givenNames:'First & other names',referenceNumber:'Student reference number',institution:'Institution',program:'Programme of study',academicLevel:'Academic level',admissionYear:'Admission year',gender:'Gender',email:'Email',phone:'Phone (call/SMS)',whatsapp:'WhatsApp phone'};
let credential=null,account=null,admin=false,busy=false,recordOffset=0,pendingOffset=0;
// An uncertain mutation stays queued with its original operation ID AND frozen payload.
// No credential or personal correction is written to browser storage.
const pendingActions=new Map();
function intentFor(op,data){const previous=pendingActions.get(op);if(previous){if(JSON.stringify(previous.data)!==JSON.stringify(data))throw Error('A previous '+op+' request has an uncertain outcome. Retry the same request before changing its values.');return previous;}const intent={operationId:uuid(),data:JSON.parse(JSON.stringify(data))};pendingActions.set(op,intent);return intent;}
function isUncertain(err){return /timed out|connection|network|backend deployment/i.test(String(err.message||''));}
function alertUI(message,error=false){
 const n=el('notice');n.textContent=message;n.classList.toggle('error',error);n.classList.remove('hide');
 const extra=el('appFeedback');if(extra){extra.textContent=message;extra.classList.toggle('error',error);extra.classList.toggle('hide',!el('profile').classList.contains('hide'));}
}
function hide(id,yes=true){el(id).classList.toggle('hide',yes);}
function uuid(){return crypto.randomUUID().replaceAll('-','');}
function esc(s){return String(s??'');} // All user-supplied data is rendered with textContent.
function node(tag,txt,cls){const e=document.createElement(tag);if(txt!==undefined)e.textContent=esc(txt);if(cls)e.className=cls;return e;}
// HTML Service places its response script in a Google-owned descendant of the form target iframe.
// Trust only that frame tree, an Apps Script response origin, and this request's fresh nonce.
function isBridgeDescendant(source, bridge){
 if(!source||!bridge)return false;
 try{for(let depth=0;depth<8;depth++){
  if(source===bridge)return true;
  const parent=source.parent;if(!parent||parent===source)return false;
  source=parent;
 }}catch(_){return false;}
 return false;
}
function isExpectedBridgeResponse(event,nonce){
 if(!isBridgeDescendant(event.source,el('bridge').contentWindow))return false;
 if(typeof event.origin!=='string'||!/^https:\/\/(?:[a-z0-9-]+-)?script\.googleusercontent\.com$/i.test(event.origin))return false;
 const v=event.data;
 return !!(v&&typeof v==='object'&&!Array.isArray(v)&&v.nonce===nonce&&typeof v.ok==='boolean');
}
function send(op,payload={}){if(!credential)return Promise.reject(Error('Please sign in again'));
 const nonce=uuid(),transport=el('transport');if(!config.endpoint||!config.endpoint.startsWith('https://script.google.com/macros/s/'))return Promise.reject(Error('Invalid backend configuration'));
 return new Promise((resolve,reject)=>{if(busy)return reject(Error('Finish the current request first'));busy=true;const activity=el('activity');if(activity)activity.classList.remove('hide');const timer=setTimeout(()=>{cleanup();reject(Error('Request timed out. Check your connection or backend deployment.'));},25000);
 function cleanup(){clearTimeout(timer);window.removeEventListener('message',onMsg);busy=false;if(activity)activity.classList.add('hide');}
 function onMsg(event){if(!isExpectedBridgeResponse(event,nonce))return;const v=event.data;cleanup();v.ok?resolve(v.value):reject(Error(v.error||'Request failed'));}
 window.addEventListener('message',onMsg);transport.action=config.endpoint;el('payload').value=JSON.stringify({op,token:credential,nonce,...payload});transport.submit();});}
function render(data){account=data;admin=!!data.admin;document.body.classList.add('signed-in');hide('appFeedback');hide('login');hide('profile',!!data.adminOnly);hide('admin',!admin);if(data.adminOnly){alertAdminOnly();return;}const status=data.status,e=status.effective||data.record;
 const area=el('details');area.replaceChildren();for(const [key,label] of Object.entries(fields)){
  const item=node('div',undefined,'detail');
  if(key==='referenceNumber'&&!/^\d+$/.test(String(e[key]||'')))item.classList.add('ref-alert');
  item.append(node('small',label),node('strong',e[key]||'—'));area.appendChild(item);
 }el('region').value=status.region||'';el('country').value=status.country||'';el('province').value=status.province||'';outside();
 const badge=el('verificationStatus'),strip=badge.closest('.status-strip');
 strip.classList.remove('is-ready','is-pending');
 if(status.pending.length){badge.textContent='Correction under review';strip.classList.add('is-pending');}
 else if(status.ready){badge.textContent='Verified · Registration-ready';strip.classList.add('is-ready');}
 else if(status.issue){badge.textContent='Action required';strip.classList.add('is-pending');}
 else if(status.confirmed){badge.textContent='Confirmation recorded';strip.classList.add('is-ready');}
 else badge.textContent='Awaiting confirmation';
 if(status.pending.length)alertUI(`${status.pending.length} correction(s) pending administrator review. Confirmation is unavailable until they are reviewed.`);
 else if(status.ready)alertUI('Your information is verified and ready for registration preparation.');
 else if(status.issue)alertUI(`Action needed: ${status.issue}`);
 else if(status.confirmed)alertUI('Your confirmation is recorded.');
 else alertUI('Review every field carefully, select your Region of Origin, then confirm or request a correction.');
 el('confirm').disabled=status.pending.length>0;
 const photo=el('photo');photo.replaceChildren();if(data.record.hasPhoto){photo.append(node('span','Photo is on file. '));const button=node('button','View private photo','secondary');button.type='button';button.onclick=async()=>{try{button.disabled=true;const p=await send('photo');const img=document.createElement('img');img.alt='Your registration photograph';img.src=`data:${p.mime};base64,${p.data}`;photo.replaceChildren(img);}catch(err){alertUI(err.message,true);}finally{button.disabled=false;}};photo.append(button);}
}
function alertAdminOnly(){el('summary').textContent='Administrator access enabled. No student registration record is required.';}
async function reload(){try{render(await send('mine'));if(admin)await loadAdmin();}catch(err){alertUI(err.message,true);}}
async function handleAuth(response){pendingActions.clear();credential=response.credential;try{await reload();}catch(err){hide('profile');hide('admin');hide('login',false);document.body.classList.remove('signed-in');alertUI(err.message,true);}}
function outside(){const outsideGhana=el('region').value==='Outside Ghana';hide('outside',!outsideGhana);el('country').required=outsideGhana;}
async function operate(op,data){let intent;try{intent=intentFor(op,data);const result=await send(op,{operationId:intent.operationId,...intent.data});pendingActions.delete(op);await reload();if(op==='correct')alertUI('Your correction was submitted for administrator review.');if(op==='confirm')alertUI('Your confirmation was recorded. Check the verification status above.');if(op==='review')alertUI('The administrator decision was recorded.');return result;}catch(err){if(intent&&!isUncertain(err))pendingActions.delete(op);alertUI(err.message+(intent&&isUncertain(err)?' Retry this same action to safely check whether it completed.':''),true);return null;}}
async function loadAdmin(){if(!admin)return;try{const res=await send('adminList',{query:el('search').value,offset:recordOffset,pendingOffset});el('summary').textContent=`Records ${res.total?res.offset+1:0}–${res.offset+res.records.length} of ${res.total}; pending corrections ${res.totalPending?res.pendingOffset+1:0}–${res.pendingOffset+res.pending.length} of ${res.totalPending}.`;
 el('metricRecords').textContent=String(res.total);
 el('metricPending').textContent=String(res.totalPending);
 el('metricReady').textContent=String(res.records.filter(x=>x.ready).length);
 el('recordPageInfo').textContent=`${res.total?res.offset+1:0}–${res.offset+res.records.length} of ${res.total}`;
 el('pendingPageInfo').textContent=`${res.totalPending?res.pendingOffset+1:0}–${res.pendingOffset+res.pending.length} of ${res.totalPending}`;el('prevRecords').disabled=recordOffset===0;el('nextRecords').disabled=recordOffset+res.records.length>=res.total;el('prevPending').disabled=pendingOffset===0;el('nextPending').disabled=pendingOffset+res.pending.length>=res.totalPending;
 const pend=el('pending');pend.replaceChildren();if(!res.pending.length)pend.append(node('p','No pending corrections.'));res.pending.forEach(x=>{const box=node('div',undefined,'request');box.append(node('strong',fields[x.field]||x.field),node('p',`Original: ${x.original}`),node('p',`Proposed: ${x.proposed}`),node('small',`Request ID: ${x.id}`));const actions=node('div',undefined,'actions');for(const decision of ['APPROVED','REJECTED']){const b=node('button',decision==='APPROVED'?'Approve':'Reject',decision==='REJECTED'?'button-secondary button-danger':'button-primary');b.type='button';b.onclick=async()=>{if(!confirm(`${decision==='APPROVED'?'Approve':'Reject'} this correction?`))return;const reason=prompt('Decision reason (optional):')||'';const r=await operate('review',{requestId:x.id,decision,reason});if(r)await loadAdmin();};actions.append(b);}box.append(actions);pend.append(box);});
 const rec=el('records');rec.replaceChildren();res.records.forEach(x=>{const line=node('div',undefined,'record');const info=node('div',undefined,'record-info');info.append(node('strong',x.name),node('small',`${x.referenceNumber} · ${x.program} · ${x.level}`));line.append(info,node('span',x.ready?'REGISTRATION-READY':x.issue||'Not ready','pill '+(x.ready?'is-ready':'is-warning')));rec.append(line);});}catch(err){alertUI(err.message,true);}}
document.addEventListener('DOMContentLoaded',()=>{
 regions.forEach(x=>{const opt=new Option(x,x);el('region').add(opt)});Object.entries(fields).forEach(([id,label])=>el('field').add(new Option(label,id)));
 el('region').addEventListener('change',outside);
 el('toggleCorrection').onclick=()=>{const open=el('correction').classList.contains('hide');hide('correction',!open);el('toggleCorrection').setAttribute('aria-expanded',String(open));};
 el('confirm').onclick=()=>{if(!confirm('Confirm that your information is correct?'))return;operate('confirm',{region:el('region').value,country:el('country').value,province:el('province').value});};
 el('sendCorrection').onclick=async()=>{const v=el('newValue').value.trim();if(!v)return alertUI('Enter the proposed correct value',true);const r=await operate('correct',{field:el('field').value,value:v});if(r){hide('correction');el('newValue').value='';}};
 const signOut=()=>{credential=null;account=null;admin=false;pendingActions.clear();hide('profile');hide('admin');hide('login',false);hide('appFeedback');document.body.classList.remove('signed-in');el('details').replaceChildren();if(window.google?.accounts?.id)google.accounts.id.disableAutoSelect();};
 el('signout').onclick=signOut;el('signoutAdmin').onclick=signOut;
 el('refreshAdmin').onclick=loadAdmin;for(const [id,dimension,delta] of [['prevRecords','records',-25],['nextRecords','records',25],['prevPending','pending',-25],['nextPending','pending',25]])el(id).onclick=()=>{if(dimension==='records')recordOffset=Math.max(0,recordOffset+delta);else pendingOffset=Math.max(0,pendingOffset+delta);loadAdmin();};
 let searchTimer;el('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{recordOffset=0;pendingOffset=0;loadAdmin();},400);};
 const init=()=>{if(!window.google?.accounts?.id){setTimeout(init,250);return;}if(!config.googleClientId||config.googleClientId.startsWith('REPLACE')){el('signin').textContent='Configure Google Client ID in config.js before deployment.';return;}google.accounts.id.initialize({client_id:config.googleClientId,callback:handleAuth,auto_select:false});google.accounts.id.renderButton(el('signin'),{theme:'outline',size:'large',text:'signin_with',width:260});};init();
});
