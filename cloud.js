/* CASA cloud: accounts (email OTP / magic link), household sync (per-item LWW), realtime, offline cache.
   Loaded before app.js; touches app.js globals (data, page, render, go, toast, esc, avatar, casaLogo, LocalQR) lazily. */
(()=>{
const SB_URL='https://qjvziiucwefngxbucqtn.supabase.co';
const SB_KEY='sb_publishable_Wz-Wi7grtn8EGpbQfB0JAQ_YT9ycjLU'; // publishable (public) key only
const ARR=['shopping','tasks','menu','plannedMeals','calendar','expenses'];
const WHO=['tasks','expenses'];
const SEP='\u0001';
const CACHE='casa-cloud-v1:';
const INVITE_KEY='casa-pending-invite',EMAIL_KEY='casa-otp-email',LAST_UID='casa-last-uid';
const DEMO_KEY='couple-demo-v1';
const MAX_MEMBERS=12;
const SLOTS='ABCDEFGHIJKL'.split('');
const LEGACY_ME='רועי',LEGACY_PARTNER='מאיה'; // old demo who-values → mapped to slots on sync

let sb=null;
try{sb=window.supabase.createClient(SB_URL,SB_KEY,{auth:{flowType:'implicit',persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storageKey:'casa-auth'}})}catch(e){console.warn('CASA: supabase unavailable',e)}

const C=window.CASA_CLOUD={active:false,sb,user:null,hh:null,members:[],base:{},pending:{},profilePending:null,housePending:null,
  status:'idle',channel:null,invite:null,inviteInfo:null,joinError:null,busy:false,deferred:false,
  authPages:['login','code','setup','join','loading'],bare:['login','code','setup','join','loading']};

/* ---------- utils ---------- */
const stable=v=>{if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(x=>x===undefined?'null':stable(x)).join(',')+']';return '{'+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}'};
const itemId=el=>el&&typeof el==='object'&&el.id!=null&&el.id!==''?String(el.id):'v:'+stable(el);
const mySlot=()=>C.me?.slot||'A';
const otherSlots=()=>C.members.filter(m=>m.user_id!==C.user?.id).map(m=>m.slot);
const nameFromEmail=email=>{const local=String(email||'').split('@')[0]||'';const parts=local.split(/[._\-\d]+/).filter(Boolean);const first=parts[0]||local;if(!first)return '';return first.charAt(0).toUpperCase()+first.slice(1).toLowerCase()};
// Store who as slot (A–L) or 'ביחד'. Accept legacy demo Hebrew who-values when migrating.
const whoOut=w=>{if(w==='ביחד'||w==null)return w;if(SLOTS.includes(w))return w;if(w===LEGACY_ME||w==='me')return mySlot();if(w===LEGACY_PARTNER||w==='other'){const o=otherSlots()[0];return o||'B'}const byName=C.members.find(m=>m.display_name===w);return byName?byName.slot:w};
const whoIn=w=>w; // keep slots locally when signed in
const mapWho=(s,el,f)=>WHO.includes(s)&&el&&typeof el==='object'&&'who' in el?{...el,who:f(el.who)}:el;
const baseUrl=()=>{const u=new URL(location.href);u.search='';u.hash='';u.pathname=u.pathname.replace(/index\.html$/,'');return u.href};
const H=s=>esc(s==null?'':s);
const toHouse=n=>{n=String(n||'');return /^ה/.test(n)?'ל'+n.slice(1):'ל־'+n};
window.T=(cloud,demo)=>C.active?cloud:demo;
window.nameFromEmail=nameFromEmail;
window.CASA_MAX_MEMBERS=MAX_MEMBERS;
// numeric ids unique across both phones (ms timestamp * 1000 + random), monotonic per device
let lastId=0;window.newId=()=>{const r=new Uint16Array(1);crypto.getRandomValues(r);lastId=Math.max(lastId+1,Date.now()*1000+(r[0]%1000));return lastId};
window.whoName=w=>{if(!w||w==='ביחד')return w==='ביחד'?'ביחד':w;if(C.active){const m=C.members.find(x=>x.slot===w);if(m){if(m.user_id===C.user?.id&&C.profilePending?.display_name!=null)return C.profilePending.display_name;return m.display_name||w}if(data.profiles?.bySlot?.[w]?.name)return data.profiles.bySlot[w].name}if(w===LEGACY_ME)return data.profiles?.roei?.name||w;if(w===LEGACY_PARTNER)return data.profiles?.maya?.name||w;return w};


/* ---------- photos (private storage bucket) ---------- */
const PHOTO_BUCKET='photos';
const PHOTO_URL_CACHE='casa-photo-urls-v1';
const PHOTO_TTL=7*24*60*60;
const urlMem={};
let urlDisk=null;
let migrateTimer=null;
const pendingSigns={};
C.localPhotos=C.localPhotos||{};
function loadUrlDisk(){if(urlDisk)return urlDisk;try{urlDisk=JSON.parse(localStorage.getItem(PHOTO_URL_CACHE)||'{}')}catch{urlDisk={}}return urlDisk}
function saveUrlDisk(){try{localStorage.setItem(PHOTO_URL_CACHE,JSON.stringify(urlDisk||{}))}catch{}}
function isDataUrl(p){return typeof p==='string'&&p.startsWith('data:')}
function photoPath(p){
  if(!p)return '';
  if(typeof p==='object')return p.path||'';
  if(typeof p!=='string')return '';
  if(p.startsWith('data:')||p.startsWith('blob:')||p.startsWith('http'))return '';
  if(p.startsWith('{')){try{const o=JSON.parse(p);return o&&o.path||''}catch{return ''}}
  if(/^[0-9a-fA-F-]{36}\//.test(p))return p;
  return '';
}
function parseAvatar(a){
  if(!a)return null;
  if(typeof a==='object')return a.path?a:null;
  if(typeof a!=='string')return null;
  if(a.startsWith('data:')||a.startsWith('blob:')||a.startsWith('http'))return a;
  if(a.startsWith('{')){try{const o=JSON.parse(a);return o&&o.path?o:null}catch{return null}}
  if(photoPath(a))return {path:a};
  return null;
}
function avatarStore(p){
  if(!p||isDataUrl(p))return null;
  const path=photoPath(p);if(!path)return typeof p==='string'&&p.startsWith('{')?p:null;
  const o=typeof p==='object'?p:{path};
  return JSON.stringify({path:o.path,w:o.w||0,h:o.h||0});
}
function stripLocalPhotos(el){
  if(!el||typeof el!=='object'||Array.isArray(el))return el;
  if(isDataUrl(el.photo)){const c={...el};delete c.photo;return c}
  return el;
}
C.isDataUrl=isDataUrl;
C.photoPath=photoPath;
C.isPhotoRef=p=>!!photoPath(p);
C.parseAvatar=parseAvatar;
C.hasPhoto=p=>!!(isDataUrl(p)||(typeof p==='string'&&(p.startsWith('blob:')||p.startsWith('http')))||photoPath(p));
C.peekPhotoUrl=p=>{
  if(isDataUrl(p)||(typeof p==='string'&&(p.startsWith('blob:')||p.startsWith('http'))))return p;
  const path=photoPath(p);if(!path)return '';
  const hit=urlMem[path]||loadUrlDisk()[path];
  if(hit&&hit.url&&hit.exp>Date.now()+60000){urlMem[path]=hit;return hit.url}
  return '';
};
async function signPhoto(path){
  if(!sb||!path)return '';
  const cached=C.peekPhotoUrl({path});if(cached)return cached;
  const{data,error}=await sb.storage.from(PHOTO_BUCKET).createSignedUrl(path,PHOTO_TTL);
  if(error||!data?.signedUrl){console.warn('CASA photo url',error);return ''}
  const rec={url:data.signedUrl,exp:Date.now()+PHOTO_TTL*1000-60000};
  urlMem[path]=rec;loadUrlDisk()[path]=rec;saveUrlDisk();
  return rec.url;
}
C.resolvePhoto=p=>{
  if(isDataUrl(p)||(typeof p==='string'&&(p.startsWith('blob:')||p.startsWith('http'))))return Promise.resolve(p);
  const path=photoPath(p);if(!path)return Promise.resolve('');
  const hit=C.peekPhotoUrl({path});if(hit)return Promise.resolve(hit);
  return pendingSigns[path]||(pendingSigns[path]=signPhoto(path).finally(()=>{delete pendingSigns[path]}));
};
C.photoTag=(photo,cls,alt,extra='')=>{
  const path=photoPath(photo);
  const url=path?C.peekPhotoUrl({path}):((isDataUrl(photo)||(typeof photo==='string'&&(photo.startsWith('blob:')||photo.startsWith('http'))))?photo:'');
  const clsN=(cls||'').trim();
  if(url)return `<img class="${clsN}" src="${url}" alt="${esc(alt||'')}" loading="lazy"${path?` data-photo-path="${esc(path)}"`:''}${extra}>`;
  if(path)return `<span class="photowait ${clsN}" data-photo-path="${esc(path)}" role="img" aria-label="${esc(alt||'טוענים תמונה')}"${extra}></span>`;
  return '';
};
C.bindPhotos=()=>{
  document.querySelectorAll('[data-photo-path]').forEach(el=>{
    const path=el.getAttribute('data-photo-path');
    C.resolvePhoto({path}).then(url=>{
      if(!url||el.getAttribute('data-photo-path')!==path||!el.isConnected)return;
      if(el.tagName==='IMG'){if(el.getAttribute('src')!==url)el.src=url;return}
      const img=document.createElement('img');
      img.className=el.className.replace(/\bphotowait\b/g,'').trim();
      img.src=url;img.alt=el.getAttribute('aria-label')||'';img.loading='lazy';
      img.setAttribute('data-photo-path',path);
      el.replaceWith(img);
    });
  });
};
function dataUrlToBlob(u){
  const i=u.indexOf(',');
  const raw=atob(u.slice(i+1));
  const arr=new Uint8Array(raw.length);
  for(let k=0;k<raw.length;k++)arr[k]=raw.charCodeAt(k);
  return new Blob([arr],{type:'image/jpeg'});
}
function photoDims(u){return new Promise(res=>{const im=new Image();im.onload=()=>res({w:im.naturalWidth,h:im.naturalHeight});im.onerror=()=>res({w:0,h:0});im.src=u})}
C.rememberLocalPhoto=(section,id,dataUrl)=>{
  C.localPhotos=C.localPhotos||{};
  const k=section==='profile'?'profile':(section+SEP+id);
  if(dataUrl)C.localPhotos[k]=dataUrl;else delete C.localPhotos[k];
  persist();
};
function applyLocalPhotos(d){
  const lp=C.localPhotos||{};
  for(const s of ['menu','shopping'])for(const el of d[s]||[]){
    const k=s+SEP+itemId(el);
    if(lp[k]&&!photoPath(el.photo))el.photo=lp[k];
  }
  if(d.profiles?.roei&&lp.profile&&!photoPath(d.profiles.roei.photo))d.profiles.roei.photo=lp.profile;
}
C.uploadPhoto=async dataUrl=>{
  if(!C.active||!C.hh||!sb)return dataUrl;
  if(!isDataUrl(dataUrl))throw new Error('no-photo');
  const blob=dataUrlToBlob(dataUrl);
  const id=(crypto.randomUUID&&crypto.randomUUID())||('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,ch=>{const r=Math.random()*16|0;return (ch==='x'?r:(r&0x3|0x8)).toString(16)}));
  const path=`${C.hh.id}/${id}.jpg`;
  const{error}=await sb.storage.from(PHOTO_BUCKET).upload(path,blob,{contentType:'image/jpeg',upsert:false,cacheControl:'31536000'});
  if(error)throw error;
  const d=await photoDims(dataUrl);
  const rec={path,w:d.w,h:d.h};
  C.resolvePhoto(rec).catch(()=>{});
  return rec;
};
C.removePhoto=async p=>{
  const path=photoPath(p)||(typeof p==='string'&&!isDataUrl(p)?p:'');
  if(!C.active||!sb||!path)return;
  try{const{error}=await sb.storage.from(PHOTO_BUCKET).remove([path]);if(error)throw error}catch(e){console.warn('CASA photo delete',e)}
};
async function migrateLocalPhotos(){
  if(!C.active||!data||!sb)return;
  let changed=false;
  const tryItem=async(section,el)=>{
    if(!el||!isDataUrl(el.photo))return;
    const raw=el.photo;
    try{
      const rec=await C.uploadPhoto(raw);
      el.photo=rec;
      C.rememberLocalPhoto(section,itemId(el),null);
      changed=true;
    }catch(e){console.warn('CASA photo migrate',e);C.rememberLocalPhoto(section,itemId(el),raw)}
  };
  for(const m of data.menu||[])await tryItem('menu',m);
  for(const t of data.shopping||[])await tryItem('shopping',t);
  const me=data.profiles?.roei;
  if(me&&isDataUrl(me.photo)){
    const raw=me.photo;
    try{
      const rec=await C.uploadPhoto(raw);
      me.photo=rec;
      C.rememberLocalPhoto('profile',null,null);
      changed=true;
    }catch(e){console.warn('CASA avatar migrate',e);C.rememberLocalPhoto('profile',null,raw)}
  }
  if(changed){if(typeof save==='function')save();C.bindPhotos()}
}
function scheduleMigrate(){clearTimeout(migrateTimer);migrateTimer=setTimeout(()=>{migrateLocalPhotos().catch(e=>console.warn('CASA photo migrate',e))},400)}
C.migratePhotos=migrateLocalPhotos;

/* ---------- cache ---------- */
function persist(){if(!C.active||!C.user||!C.hh)return;try{localStorage.setItem(CACHE+C.user.id,JSON.stringify({hh:C.hh,members:C.members,base:C.base,pending:C.pending,profilePending:C.profilePending,housePending:C.housePending,localPhotos:C.localPhotos||{}}));localStorage.setItem(LAST_UID,C.user.id)}catch(e){console.warn('CASA cache',e)}}
function loadCache(uid){try{return JSON.parse(localStorage.getItem(CACHE+uid)||'null')}catch{return null}}

/* ---------- model ---------- */
function view(){const v={};for(const k in C.base)v[k]=C.base[k];for(const k in C.pending)v[k]=C.pending[k];return v}
function materialize(){
  const v=view(),d={};for(const s of ARR)d[s]=[];const tmp={};
  for(const k in v){const e=v[k];if(e.d)continue;let val;try{val=JSON.parse(e.v)}catch{continue}
    if(e.s==='_root'){d[e.i]=val;continue}
    if(!ARR.includes(e.s))continue;(tmp[e.s]=tmp[e.s]||[]).push([e.p||0,e.i,mapWho(e.s,val,whoIn)])}
  for(const s in tmp)d[s]=tmp[s].sort((a,b)=>a[0]-b[0]||(a[1]<b[1]?-1:a[1]>b[1]?1:0)).map(x=>x[2]);
  if(d.v2Tasks===undefined)d.v2Tasks=true;if(d.artV3===undefined)d.artV3=true;if(!d.freq)d.freq={};
  const meName=C.profilePending?.display_name??(C.me?.display_name||nameFromEmail(C.user?.email)||'אני');
  const mePhoto=parseAvatar(C.profilePending?C.profilePending.avatar:(C.me?.avatar||null));
  const bySlot={};
  for(const m of C.members){
    const isMe=m.user_id===C.user?.id;
    bySlot[m.slot]={name:isMe?meName:(m.display_name||'חבר/ה'),photo:isMe?mePhoto:parseAvatar(m.avatar||null),user_id:m.user_id};
  }
  if(C.me&&!bySlot[C.me.slot])bySlot[C.me.slot]={name:meName,photo:mePhoto,user_id:C.user?.id};
  const others=C.members.filter(m=>m.user_id!==C.user?.id);
  d.profiles={roei:{name:meName,photo:mePhoto},
              maya:{name:others[0]?.display_name||'חבר/ה',photo:parseAvatar(others[0]?.avatar||null)},
              bySlot,meSlot:C.me?.slot||'A'};
  d.houseName=C.hh?.name;
  applyLocalPhotos(d);
  data=d;
}
function entries(){
  const out={};
  for(const s of ARR)(data[s]||[]).forEach(el=>{const i=itemId(el);out[s+SEP+i]={s,i,v:stable(stripLocalPhotos(mapWho(s,el,whoOut)))}});
  for(const k of Object.keys(data)){if(ARR.includes(k)||k==='profiles'||k==='houseName'||data[k]===undefined)continue;out['_root'+SEP+k]={s:'_root',i:k,v:stable(data[k])}}
  return out;
}
function posFor(s,i,v){
  const arr=(data[s]||[]).map(itemId),j=arr.indexOf(i);const pos=x=>{const e=v[s+SEP+x];return e&&!e.d?e.p:undefined};
  let prev,next;for(let a=j-1;a>=0;a--){const p=pos(arr[a]);if(p!==undefined){prev=p;break}}
  for(let a=j+1;a<arr.length;a++){const p=pos(arr[a]);if(p!==undefined){next=p;break}}
  if(prev!==undefined&&next!==undefined)return (prev+next)/2;if(prev!==undefined)return prev+1;if(next!==undefined)return next-1;return 0;
}
C.onSave=()=>{
  if(!C.active)return true;
  const cur=entries(),v=view();let changed=0;
  for(const k in cur){const e=v[k];if(!e||e.d||e.v!==cur[k].v){const c=cur[k];c.p=e&&!e.d?e.p:posFor(c.s,c.i,v);c.d=false;C.pending[k]=c;v[k]=c;changed++}}
  for(const k in v){if(!cur[k]&&!v[k].d){C.pending[k]={...v[k],v:'{}',d:true};changed++}}
  const r=data.profiles?.roei;
  if(r&&C.me){
    const name=String(r.name||'').slice(0,40);
    const av=avatarStore(r.photo);
    const nameChanged=name!==(C.me.display_name||'');
    const photoChanged=!!av&&av!==(C.me.avatar||null);
    if(isDataUrl(r.photo)){C.rememberLocalPhoto('profile',null,r.photo);scheduleMigrate()}
    if(nameChanged||photoChanged){
      const pp={display_name:name,avatar:photoChanged?av:(C.profilePending?.avatar??C.me.avatar??null)};
      C.profilePending=pp;changed++;
    }
  }
  if(data.houseName!=null&&C.hh&&String(data.houseName)!==String(C.hh.name||'')){C.housePending=String(data.houseName).trim().slice(0,80)||C.hh.name;changed++}
  if(changed){persist();scheduleFlush(150)}
  return true;
};

/* ---------- sync ---------- */
let flushTimer=null,flushing=false,backoff=2000;
function scheduleFlush(ms){clearTimeout(flushTimer);flushTimer=setTimeout(flush,ms)}
function setStatus(s){if(C.status===s)return;C.status=s;const b=document.querySelector('#casa-banner');if(b||s==='offline'){softRender()}}
async function flush(){
  if(!C.active||flushing)return;
  const keys=Object.keys(C.pending);
  if(!keys.length&&!C.profilePending&&C.housePending==null){setStatus('synced');return}
  if(!navigator.onLine){setStatus('offline');return}
  flushing=true;setStatus('syncing');
  try{
    if(C.profilePending){const pp=C.profilePending;const{error}=await sb.from('household_members').update(pp).eq('household_id',C.hh.id).eq('user_id',C.user.id);if(error)throw error;
      if(C.profilePending===pp){C.profilePending=null;Object.assign(C.me,pp)}}
    if(C.housePending!=null){const hn=C.housePending;const{error}=await sb.from('households').update({name:hn}).eq('id',C.hh.id);if(error)throw error;
      if(C.housePending===hn){C.hh.name=hn;C.housePending=null;if(data)data.houseName=hn}}
    for(let a=0;a<keys.length;a+=200){
      const chunk=keys.slice(a,a+200).map(k=>[k,C.pending[k]]);
      const rows=chunk.map(([,e])=>({household_id:C.hh.id,section:e.s,item_id:e.i,data:e.d?{}:JSON.parse(e.v),pos:e.p||0,deleted:!!e.d}));
      const{error}=await sb.from('household_items').upsert(rows,{onConflict:'household_id,section,item_id'});
      if(error)throw error;
      for(const[k,e]of chunk){C.base[k]=e;if(C.pending[k]===e)delete C.pending[k]}
    }
    persist();backoff=2000;flushing=false;
    if(Object.keys(C.pending).length||C.profilePending||C.housePending!=null)return flush();
    setStatus('synced');
  }catch(e){flushing=false;console.warn('CASA sync',e);setStatus(navigator.onLine?'error':'offline');persist();scheduleFlush(backoff);backoff=Math.min(backoff*2,60000)}
}
const rowEntry=r=>({s:r.section,i:r.item_id,v:r.deleted?'{}':stable(r.data),p:r.pos,d:!!r.deleted});
async function fetchAll(){
  const hid=C.hh.id;const rows=[];
  for(let from=0;;from+=1000){const{data:d,error}=await sb.from('household_items').select('section,item_id,data,pos,deleted').eq('household_id',hid).range(from,from+999);if(error)throw error;rows.push(...d);if(d.length<1000)break}
  if(!C.active||C.hh?.id!==hid)return;
  const base={};for(const r of rows)base[r.section+SEP+r.item_id]=rowEntry(r);C.base=base;
  for(const k in C.pending){const p=C.pending[k],b=base[k];if(b&&b.v===p.v&&b.d===p.d)delete C.pending[k]}
  await fetchMembers();
}
async function fetchMembers(){
  const hid=C.hh.id;
  const[{data:m,error},{data:h}]=await Promise.all([sb.from('household_members').select('household_id,user_id,slot,display_name,avatar,joined_at').eq('household_id',hid).order('slot'),sb.from('households').select('id,name').eq('id',hid).maybeSingle()]);
  if(error)throw error;if(!C.active||C.hh?.id!==hid)return;C.members=m||[];C.me=C.members.find(x=>x.user_id===C.user.id)||C.me;if(h)C.hh=h;
}
function applyRow(r){
  if(!r||r.household_id!==C.hh?.id)return;
  const k=r.section+SEP+r.item_id,e=rowEntry(r),old=C.base[k];C.base[k]=e;
  const p=C.pending[k];if(p&&p.v===e.v&&p.d===e.d)delete C.pending[k];
  if(p)return persist(); // local edit wins until flushed
  if(old&&old.v===e.v&&old.d===e.d&&old.p===e.p)return;
  persist();softRender();
}
function subscribe(){
  if(C.channel){sb.removeChannel(C.channel);C.channel=null}
  const hid=C.hh.id;let first=true;
  C.channel=sb.channel('casa:'+hid)
    .on('postgres_changes',{event:'*',schema:'public',table:'household_items',filter:`household_id=eq.${hid}`},p=>applyRow(p.new))
    .on('postgres_changes',{event:'*',schema:'public',table:'household_members',filter:`household_id=eq.${hid}`},()=>fetchMembers().then(()=>{persist();softRender()}).catch(()=>{}))
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'households',filter:`id=eq.${hid}`},p=>{if(p.new?.name){C.hh.name=p.new.name;persist();softRender()}})
    .subscribe(st=>{if(st==='SUBSCRIBED'){if(!first)resync();first=false;C.realtime='live'}else if(st==='CHANNEL_ERROR'||st==='TIMED_OUT'||st==='CLOSED'){C.realtime='down'}});
}
async function resync(){if(!C.active)return;try{await fetchAll();persist();softRender();flush()}catch(e){console.warn('CASA resync',e)}}
function softRender(){
  if(!C.active&&!C.authPages.includes(page))return;
  if(C.active)materialize();
  const a=document.activeElement;const typing=a&&a!==document.body&&a.closest?.('#app')&&/INPUT|TEXTAREA|SELECT/.test(a.tagName)&&!a.readOnly;
  if(typing&&a.id&&!a.value&&a.tagName==='INPUT'&&!document.querySelector('#crop-modal:not([hidden])')){const id=a.id;render();document.getElementById(id)?.focus({preventScroll:true});return}
  if(typing||document.querySelector('#crop-modal:not([hidden])')){if(!C.deferred){C.deferred=true;document.addEventListener('focusout',()=>setTimeout(()=>{if(C.deferred){C.deferred=false;softRender()}},50),{once:true})}return}
  render();
}
window.addEventListener('online',()=>{if(C.active){setStatus('syncing');resync()}});
window.addEventListener('offline',()=>{if(C.active)setStatus('offline')});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&C.active&&navigator.onLine)resync()});

/* ---------- enter / leave ---------- */
async function enterCloud(hh,{fromCache}={}){
  C.hh=hh;C.active=true;
  if(!fromCache){C.base={};C.pending={};C.members=[];C.profilePending=null;C.housePending=null;C.localPhotos={}}
  if(!C.me)C.me=C.members.find(x=>x.user_id===C.user.id)||null;
  materialize();
  try{await fetchAll();persist()}catch(e){console.warn('CASA fetch',e);if(!fromCache)throw e}
  materialize();sb.realtime.setAuth((await sb.auth.getSession()).data.session?.access_token);subscribe();flush();
  migrateLocalPhotos().catch(e=>console.warn('CASA photo migrate',e));
}
async function findHousehold(){
  const{data:m,error}=await sb.from('household_members').select('household_id,slot,display_name,avatar,households(id,name)').eq('user_id',C.user.id).maybeSingle();
  if(error)throw error;if(!m)return null;C.me={...m,user_id:C.user.id};return m.households;
}
function leaveCloud(){
  if(C.channel){sb.removeChannel(C.channel);C.channel=null}
  C.active=false;C.hh=null;C.members=[];C.me=null;C.base={};C.pending={};C.profilePending=null;C.housePending=null;C.localPhotos={};C.invite=null;
  try{data=JSON.parse(localStorage.getItem(DEMO_KEY))||structuredClone(initial)}catch{data=structuredClone(initial)}
}
async function afterSignIn(){
  page='loading';render();
  try{
    const hh=await findHousehold();
    const inv=localStorage.getItem(INVITE_KEY);
    if(hh&&inv){const{data:info}=await sb.rpc('invite_info',{p_token:inv});if(info?.[0]?.status==='member'){localStorage.removeItem(INVITE_KEY)}else{C.inviteInfo=info?.[0]||{status:'invalid'};C.pendingHH=hh;page='join';return render()}}
    if(hh){await enterCloud(hh);page='home';return render()}
    if(inv){const{data:info}=await sb.rpc('invite_info',{p_token:inv});C.inviteInfo=info?.[0]||{status:'invalid'};page='join';return render()}
    page='setup';render();
  }catch(e){console.warn(e);page='login';C.authError='לא הצלחנו להתחבר לשרת. בדקו את החיבור ונסו שוב.';render()}
}

/* ---------- boot ---------- */
C.boot=async()=>{
  const url=new URL(location.href);const inv=url.searchParams.get('invite');
  if(inv&&/^[0-9a-f-]{36}$/i.test(inv))localStorage.setItem(INVITE_KEY,inv);
  if(inv){url.searchParams.delete('invite');history.replaceState(null,'',url.pathname+url.search+url.hash)}
  const hashErr=new URLSearchParams(location.hash.slice(1)).get('error_description');
  if('serviceWorker' in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('sw.js?v=1794349000').catch(()=>{});
  if(!sb){page=localStorage.getItem(INVITE_KEY)?'welcome':'welcome';return render()}
  // instant open from cache
  const lastUid=localStorage.getItem(LAST_UID),cache=lastUid&&loadCache(lastUid);
  if(cache?.hh){C.user={id:lastUid};Object.assign(C,{hh:cache.hh,members:cache.members||[],base:cache.base||{},pending:cache.pending||{},profilePending:cache.profilePending||null,housePending:cache.housePending??null,localPhotos:cache.localPhotos||{}});C.me=C.members.find(m=>m.user_id===lastUid)||null;C.active=true;materialize();page='home';render()}
  else{page=localStorage.getItem(INVITE_KEY)?'join':'welcome';render()}
  const{data:{session}}=await sb.auth.getSession();
  if(hashErr){history.replaceState(null,'',location.pathname);toast('הקישור מהמייל לא תקף יותר. אפשר לבקש קוד חדש.')}
  if(!session){if(C.active){leaveCloud();page=localStorage.getItem(INVITE_KEY)?'join':'welcome';render()}return}
  C.user=session.user;
  if(C.active&&cache?.hh&&lastUid===session.user.id&&!localStorage.getItem(INVITE_KEY)){enterCloud(C.hh,{fromCache:true}).then(()=>softRender()).catch(e=>{console.warn(e);setStatus('offline')});return}
  if(C.active)leaveCloud();
  afterSignIn();
};
sb?.auth.onAuthStateChange((ev,session)=>{
  if(ev==='SIGNED_OUT'&&C.active){leaveCloud();page='welcome';setTimeout(render)}
  if(ev==='TOKEN_REFRESHED'&&session)sb.realtime.setAuth(session.access_token);
  if(ev==='SIGNED_IN'&&session&&!C.user&&location.hash.includes('access_token')){/* magic link landing; boot() handles it */}
});

/* ---------- auth actions ---------- */
const otpErr=e=>{const m=(e?.message||'')+'';if(e?.code==='email_address_not_authorized'||/not.authorized/i.test(m))return 'עדיין אי אפשר לשלוח קוד לכתובת הזו — שרת המייל של CASA פתוח כרגע רק לכתובות מאושרות.';if(e?.status===429||/rate limit|security purposes|only request/i.test(m))return 'נשלחו יותר מדי קודים בזמן קצר. חכו כמה דקות ונסו שוב.';if(/invalid.*email|email.*invalid/i.test(m))return 'כתובת המייל לא נראית תקינה.';if(!navigator.onLine)return 'אין חיבור לאינטרנט כרגע.';return 'משהו השתבש בשליחה. נסו שוב בעוד רגע.'};
async function sendCode(email){
  const{error}=await sb.auth.signInWithOtp({email,options:{shouldCreateUser:true,emailRedirectTo:baseUrl()}});
  if(error)throw error;localStorage.setItem(EMAIL_KEY,email);C.sentAt=Date.now();
}
async function verifyCode(code){
  const email=localStorage.getItem(EMAIL_KEY);
  const{data:d,error}=await sb.auth.verifyOtp({email,token:code,type:'email'});
  if(error)throw error;C.user=d.user;localStorage.removeItem(EMAIL_KEY);await afterSignIn();
}
C.signOut=async()=>{
  const uid=C.user?.id;await flush().catch(()=>{});
  if(uid)localStorage.removeItem(CACHE+uid);localStorage.removeItem(LAST_UID);C.user=null;leaveCloud();
  try{await sb.auth.signOut({scope:'local'})}catch{}
  go('welcome');toast('התנתקת. הנתונים נשארים שמורים בחשבון.');
};

/* ---------- invites ---------- */
async function ensureInvite(force){
  if(!C.active||C.members.length>=MAX_MEMBERS)return null;
  if(!force&&C.invite&&new Date(C.invite.expires_at)>new Date()&&!C.invite.revoked_at)return C.invite;
  if(!force){const{data:list}=await sb.from('invites').select('token,expires_at,used_at,revoked_at').eq('household_id',C.hh.id).is('revoked_at',null).gt('expires_at',new Date().toISOString()).order('created_at',{ascending:false}).limit(1);if(list?.[0]){C.invite=list[0];return C.invite}}
  const{data:row,error}=await sb.from('invites').insert({household_id:C.hh.id}).select('token,expires_at,used_at,revoked_at').single();if(error)throw error;C.invite=row;return row;
}
const inviteLink=()=>C.invite?baseUrl()+'?invite='+C.invite.token:'';
const qrSrc=u=>`data:image/svg+xml;charset=utf-8,${encodeURIComponent(LocalQR.toSVG(u))}`;

/* ---------- views ---------- */
C.simpleHeader=()=>`<header class="top authtop"><div class="side left"></div><span class="brand centerbrand" aria-label="CASA">${casaLogo}</span><div class="side right"></div></header>`;
C.banner=()=>{
  const pend=Object.keys(C.pending).length+(C.profilePending?1:0)+(C.housePending!=null?1:0);
  if(C.status==='offline'||(!navigator.onLine))return `<div class="demo syncbanner" id="casa-banner" role="status">אין חיבור כרגע · ${pend?'השינויים נשמרו בטלפון ויסונכרנו כשיחזור':'מציגים את מה ששמור בטלפון'}</div>`;
  if(C.status==='error'&&pend)return `<div class="demo syncbanner" id="casa-banner" role="status">מנסים לסנכרן שוב…</div>`;
  return '<span id="casa-banner" hidden></span>';
};
C.upcomingCard=()=>{
  const today=todayISO();const next=(data.calendar||[]).filter(e=>e.date>=today).sort((a,b)=>a.date<b.date?-1:1)[0];
  if(!next)return `<section class="card upcomingcard"><div class="cardhead"><h2>לקראת השבוע</h2></div><div class="upcoming"><div class="dateblock">השבוע<strong>✦</strong></div><div><h3>עוד אין תוכניות</h3><p class="sub">מנות שמתכננים מהתפריט יופיעו כאן וביומן.</p></div></div></section>`;
  const days=['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳'];const d=new Date(next.date+'T12:00:00');
  return `<section class="card upcomingcard"><div class="cardhead"><h2>לקראת השבוע</h2></div><div class="upcoming"><div class="dateblock">יום<strong>${days[d.getDay()]}</strong></div><div><h3>${H(next.title)}</h3><p class="sub">${H(next.detail||formatDayLabel(next.date))}</p></div></div></section>`;
};
const back=(to,label)=>`<button class="back" data-go="${to}">→ ${label}</button>`;
C.views={
  loading:()=>`<div class="center"><div class="card authcard"><div class="onboardingstep">רגע אחד…</div><h1>פותחים את הבית.</h1><p class="sub">מתחברים לחשבון ומביאים את הנתונים.</p></div></div>`,
  login:()=>{const inv=localStorage.getItem(INVITE_KEY);return `<div class="center">${back(inv?'join':'welcome','בחזרה')}<div class="card authcard"><div class="onboardingstep">${inv?'הצטרפות לבית משותף':'כניסה ל־CASA'}</div><h1>מה המייל שלך?</h1><p>נשלח אליך קוד כניסה חד־פעמי. בלי סיסמאות.</p><form id="login-form" novalidate><label for="login-email">אימייל</label><input id="login-email" type="email" inputmode="email" autocomplete="email" dir="ltr" placeholder="name@example.com" value="${H(localStorage.getItem(EMAIL_KEY)||'')}" required><p id="login-error" class="formerror" role="alert">${H(C.authError||'')}</p><button class="primary" id="send-code" type="submit">שליחת קוד</button></form><div class="footnote">בכניסה הראשונה נפתח לך חשבון אישי. הנתונים של הבית נשמרים בחשבון ומסונכרנים בין הטלפונים של חברי הבית.</div></div></div>`},
  code:()=>{const email=localStorage.getItem(EMAIL_KEY)||'';return `<div class="center">${back('login','החלפת מייל')}<div class="card authcard"><div class="onboardingstep">כמעט שם</div><h1>בדקו את המייל.</h1><p>שלחנו קוד כניסה אל <bdi dir="ltr" class="emailchip">${H(email)}</bdi></p><form id="code-form" novalidate><label for="otp-code">הקוד מהמייל</label><input id="otp-code" class="codeinput" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" dir="ltr" placeholder="••••••" required><p id="code-error" class="formerror" role="alert"></p><button class="primary" id="verify-code" type="submit">כניסה</button></form><button class="quiet resend" id="resend-code" type="button">לא הגיע? שליחה מחדש</button><div class="notice">הגיע קישור במקום קוד? אפשר ללחוץ עליו — הוא יפתח את CASA ויכניס אותך. כדאי לבדוק גם בתיקיית הספאם.</div></div></div>`},
  setup:()=>{const suggested=nameFromEmail(C.user?.email);return `<div class="center"><div class="card authcard"><div class="onboardingstep">01 / הבית המשותף</div><h1>מקום קטן משותף.</h1><p>עוד שני פרטים, ואז אפשר להזמין חברים לבית.</p><form id="setup-form" novalidate><label for="setup-name">איך לפנות אליך?</label><input id="setup-name" maxlength="35" autocomplete="given-name" value="${H(suggested)}" placeholder="השם שלך"><label for="setup-house" style="margin-top:14px">איך נקרא לבית?</label><input id="setup-house" maxlength="80" placeholder="משפחת כהן, המגניבים…" value=""><p id="setup-error" class="formerror" role="alert"></p><button class="primary" type="submit" id="create-household">יצירת הבית</button></form><div class="footnote">מחובר/ת בתור <bdi dir="ltr">${H(C.user?.email||'')}</bdi> · <button class="quiet inline" id="signout-setup" type="button">התנתקות</button></div></div></div>`},
  join:()=>{
    const info=C.inviteInfo;
    if(!C.user)return `<div class="center"><div class="card authcard"><div class="onboardingstep">הזמנה ל־CASA</div><h1>הוזמנת לבית משותף.</h1><p>כדי להצטרף נכנסים עם המייל. בלי סיסמאות, וזה לוקח דקה.</p><button class="primary" data-go="login">כניסה עם אימייל</button><button class="secondary" id="drop-invite">לא עכשיו</button></div></div>`;
    const msg={invalid:'ההזמנה הזו לא קיימת. בקשו קישור חדש.',expired:'תוקף ההזמנה פג. בקשו קישור חדש מההגדרות.',used:'ההזמנה כבר לא בתוקף. בקשו קישור חדש.',revoked:'ההזמנה בוטלה. בקשו קישור חדש.',full:'בבית הזה כבר יש מספיק חברים.'}[info?.status];
    if(!info)return C.views.loading();
    if(msg)return `<div class="center"><div class="card authcard"><div class="onboardingstep">הזמנה ל־CASA</div><h1>אופס.</h1><p>${msg}</p><button class="primary" id="drop-invite">${C.pendingHH?'חזרה לבית שלי':'פתיחת בית חדש במקום'}</button></div></div>`;
    const suggested=C.me?.display_name||nameFromEmail(C.user?.email)||'';
    return `<div class="center"><div class="card authcard"><div class="onboardingstep">הזמנה ל־CASA</div><h1>הצטרפות ${H(toHouse(info.household_name))}</h1><p>${info.inviter_name?H(info.inviter_name)+' מזמין/ה אותך':'הוזמנת'} לבית משותף: רשימת קניות, תפריט, יומן והוצאות — אצל כולם, מסונכרן.</p><form id="join-form" novalidate><label for="join-name">איך לפנות אליך?</label><input id="join-name" maxlength="35" autocomplete="given-name" value="${H(suggested)}"><p id="join-error" class="formerror" role="alert">${H(C.joinError||'')}</p><button class="primary" type="submit" id="accept-invite">הצטרפות לבית</button></form><button class="quiet" id="drop-invite" type="button">לא עכשיו</button><div class="footnote">מחובר/ת בתור <bdi dir="ltr">${H(C.user?.email||'')}</bdi></div></div></div>`;
  },
};
C.settings=()=>{
  const me=data.profiles.roei;
  const hasDemo=!!localStorage.getItem(DEMO_KEY)&&!localStorage.getItem('casa-migrated:'+C.hh.id)&&!localStorage.getItem('casa-migrate-dismissed:'+C.hh.id);
  const pend=Object.keys(C.pending).length+(C.profilePending?1:0)+(C.housePending!=null?1:0);
  const status=!navigator.onLine||C.status==='offline'?`אין חיבור · ${pend} שינויים ממתינים`:pend?'מסנכרן…':'הכול מסונכרן';
  const full=C.members.length>=MAX_MEMBERS;
  const bigAv=me.photo&&C.photoTag(me.photo,'avatar profilephoto prof-av',me.name||'')||`<span class="avatar initials prof-av" aria-hidden="true">${H((me.name||'?').charAt(0))}</span>`;
  const memberRows=C.members.slice().sort((a,b)=>a.slot<b.slot?-1:1).map(m=>{
    const isMe=m.user_id===C.user.id;
    const name=isMe?(C.profilePending?.display_name??(m.display_name||me.name)):(m.display_name||'חבר/ה');
    const photo=isMe?me.photo:parseAvatar(m.avatar||null);
    const av=(photo&&C.photoTag(photo,`avatar profilephoto member-slot-${m.slot}`,name))||`<span class="avatar initials member-slot-${m.slot}" role="img" aria-label="${H(name)}">${H((name||'?').charAt(0))}</span>`;
    return `<div class="memberrow">${av}<span>${H(name)}${isMe?' · את/ה':''}</span></div>`;
  }).join('');
  const inviteTools=C.invite?`<p class="sub invite-sub">כשחבר/ה לידך — סורקים את הקוד. מרחוק — שולחים את הקישור.</p><img class="qr" id="invite-qr" src="${qrSrc(inviteLink())}" alt="QR להצטרפות לבית"><div class="link" id="invite-link">${H(inviteLink())}</div><div class="invite-actions"><button class="primary" id="share-invite">שיתוף הקישור</button><button class="secondary" id="copy-invite-cloud">העתקה</button></div><button class="quiet" id="renew-invite" style="margin-top:10px">יצירת קישור חדש (הישן יבוטל)</button><div class="footnote">הקישור פתוח עד ${new Date(C.invite.expires_at).toLocaleDateString('he-IL',{timeZone:'Europe/Prague'})} או עד ביטול.</div>`
    :(full?'':'<p class="sub" style="margin-top:10px">מכינים קישור הזמנה…</p>');
  const houseName=C.housePending??C.hh.name??'';
  const cam='<span class="prof-cam" aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13.5" r="3.2"/></svg></span>';
  return `<div class="pagehead"><h1 class="withicon">${typeof avoDeco==='function'?avoDeco('tiny'):''}הגדרות</h1></div><div class="settings-stack v7set"><section class="setgroup profile-card has-avo">${typeof avoDeco==='function'?avoDeco('mark'):''}<div class="prof-row"><button type="button" class="prof-photo" id="open-photo-menu" aria-label="שינוי תמונת פרופיל">${bigAv}${cam}</button><div class="prof-fields"><input id="profile-name" class="prof-name-input" maxlength="35" value="${H(me.name)}" placeholder="השם שלך" autocomplete="given-name" aria-label="השם שלך"><small class="prof-mail" dir="ltr">${H(C.user.email||'')}</small></div><button class="primary sm" id="save-profile">שמירה</button></div><p id="photo-error" role="alert"></p><input class="uploadinput" type="file" id="profile-photo" accept="image/*" hidden><div id="photo-menu" class="photo-sheet" hidden><div class="photo-sheet-inner" role="dialog" aria-label="שינוי תמונת פרופיל"><div class="photo-sheet-handle" aria-hidden="true"></div><h3>שינוי תמונה</h3><button type="button" id="photo-pick">בחירת תמונה</button>${me.photo?`<button type="button" class="dangerish" id="remove-photo">הסרת תמונה</button>`:'<button type="button" id="remove-photo" hidden disabled>הסרת תמונה</button>'}<button type="button" class="quiet" id="photo-cancel">ביטול</button></div></div></section><div class="setlabel">הבית</div><section class="setgroup"><div class="setrow"><label for="house-name-edit">שם</label><input id="house-name-edit" maxlength="80" value="${H(houseName)}" placeholder="משפחת כהן, המגניבים…"><button class="primary sm" id="save-house-name">שמירה</button></div><div class="setrow members-row"><span class="setrow-label">חברי הבית</span><div class="members-block">${memberRows||`<div class="memberrow">${avatar('roei')}<span>${H(me.name)} · את/ה</span></div>`}</div></div></section>${full?'':`<div class="setlabel">הזמנה לבית</div><section class="card invitecard" id="household-card">${inviteTools}</section>`}${hasDemo?`<div class="setlabel">נתונים מההדגמה</div><section class="setgroup"><div class="setrow"><span class="setrow-label grow">להעביר קניות, מטלות ומנות מההדגמה?</span><button class="primary sm" id="migrate-local">העברה</button><button class="quiet" id="dismiss-migrate">לא צריך</button></div></section>`:''}<div class="setlabel">החשבון</div><section class="setgroup"><div class="setrow"><span class="setrow-label grow">סנכרון</span><span class="syncpill ${pend||!navigator.onLine?'wait':'ok'}">${status}</span></div><div class="setrow"><bdi dir="ltr" class="setrow-label grow ltrmail">${H(C.user.email||'')}</bdi><button class="secondary sm" id="sign-out">התנתקות</button></div></section></div>`;
};

/* ---------- binding ---------- */
const $q=s=>document.querySelector(s);
function busy(btn,on,label){if(!btn)return;if(on){btn.dataset.label=btn.textContent;btn.textContent=label||'רגע…';btn.disabled=true}else{btn.textContent=btn.dataset.label||btn.textContent;btn.disabled=false}}
C.bind=()=>{
  C.authError=null;
  const lf=$q('#login-form');if(lf)lf.onsubmit=async e=>{e.preventDefault();const email=$q('#login-email').value.trim().toLowerCase(),err=$q('#login-error'),btn=$q('#send-code');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)){err.textContent='כתבו כתובת מייל מלאה, למשל name@gmail.com';return}
    busy(btn,true,'שולחים…');try{await sendCode(email);go('code')}catch(x){console.warn(x);err.textContent=otpErr(x);busy(btn,false)}};
  const cf=$q('#code-form');if(cf){const inp=$q('#otp-code');inp.oninput=()=>{inp.value=inp.value.replace(/\D/g,'').slice(0,10)};setTimeout(()=>inp.focus(),50);
    cf.onsubmit=async e=>{e.preventDefault();const code=inp.value.trim(),err=$q('#code-error'),btn=$q('#verify-code');if(code.length<6){err.textContent='הקוד בן 6 ספרות לפחות.';return}
      busy(btn,true,'בודקים…');try{await verifyCode(code)}catch(x){console.warn(x);err.textContent=/expired|invalid|token/i.test(x?.message||'')?'הקוד לא נכון או שפג תוקפו. אפשר לבקש קוד חדש.':otpErr(x);busy(btn,false)}};
    $q('#resend-code').onclick=async()=>{const err=$q('#code-error');if(C.sentAt&&Date.now()-C.sentAt<60000){err.textContent=`אפשר לבקש קוד חדש בעוד ${Math.ceil((60000-(Date.now()-C.sentAt))/1000)} שניות.`;return}
      try{await sendCode(localStorage.getItem(EMAIL_KEY));toast('שלחנו קוד חדש')}catch(x){err.textContent=otpErr(x)}}}
  const sf=$q('#setup-form');if(sf){const n=$q('#setup-name'),h=$q('#setup-house');n.oninput=()=>{h.placeholder='הבית של '+(n.value.trim()||'…')};
    sf.onsubmit=async e=>{e.preventDefault();const name=n.value.trim(),err=$q('#setup-error'),btn=$q('#create-household');if(!name){err.textContent='איך לפנות אליך? מספיק שם פרטי.';n.focus();return}
      busy(btn,true,'יוצרים…');try{const{data:hid,error}=await sb.rpc('create_household',{p_name:h.value.trim()||('הבית של '+name),p_display_name:name});if(error)throw error;
        const hh=await findHousehold();await enterCloud(hh);go('home');toast('הבית מוכן. אפשר להזמין חברים מההגדרות')}catch(x){console.warn(x);err.textContent='לא הצלחנו ליצור את הבית. נסו שוב.';busy(btn,false)}}}
  const jf=$q('#join-form');if(jf)jf.onsubmit=async e=>{e.preventDefault();const name=$q('#join-name').value.trim(),err=$q('#join-error'),btn=$q('#accept-invite');if(!name){err.textContent='איך לפנות אליך? מספיק שם פרטי.';return}
    busy(btn,true,'מצטרפים…');try{const{error}=await sb.rpc('accept_invite',{p_token:localStorage.getItem(INVITE_KEY),p_display_name:name});if(error)throw error;localStorage.removeItem(INVITE_KEY);C.pendingHH=null;C.inviteInfo=null;C.joinError=null;
      if(C.active)leaveCloud();const hh=await findHousehold();await enterCloud(hh);go('home');toast('הצטרפת לבית! מעכשיו הכול משותף')}catch(x){console.warn(x);const m=x?.message||'';
      err.textContent=/already_in_household/.test(m)?'החשבון הזה כבר שייך לבית אחר עם נתונים. אפשר להתנתק ולהיכנס עם מייל אחר.':/household_full/.test(m)?'בבית הזה כבר יש שני אנשים.':/expired|used|revoked|invalid/.test(m)?'ההזמנה כבר לא בתוקף. בקשו קישור חדש.':'לא הצלחנו להצטרף. נסו שוב.';busy(btn,false)}};
  const di=$q('#drop-invite');if(di)di.onclick=async()=>{localStorage.removeItem(INVITE_KEY);C.inviteInfo=null;if(!C.user)return go('welcome');if(C.pendingHH){const hh=C.pendingHH;C.pendingHH=null;await enterCloud(hh);return go('home')}go('setup')};
  const so=$q('#signout-setup');if(so)so.onclick=()=>C.signOut();
  if(!C.active){C.bindPhotos();return}
  if(page==='settings'){
    const openMenu=$q('#open-photo-menu'),menu=$q('#photo-menu'),pick=$q('#photo-pick'),cancel=$q('#photo-cancel'),file=$q('#profile-photo');
    const showMenu=on=>{if(!menu)return;menu.hidden=!on;if(on)menu.querySelector('button')?.focus()};
    if(openMenu)openMenu.onclick=()=>showMenu(true);
    if(cancel)cancel.onclick=()=>showMenu(false);
    if(menu)menu.onclick=e=>{if(e.target===menu)showMenu(false)};
    if(pick&&file)pick.onclick=()=>{showMenu(false);file.click()};
    const sh=$q('#save-house-name'),hi=$q('#house-name-edit');
    if(sh&&hi)sh.onclick=()=>{const n=hi.value.trim();if(!n){toast('בחרו שם לבית');hi.focus();return}data.houseName=n.slice(0,80);C.housePending=data.houseName;save();render();toast('שם הבית נשמר')};
    if(!C.invite&&C.members.length<MAX_MEMBERS)ensureInvite().then(()=>{if(page==='settings')render()}).catch(e=>{console.warn(e);const h=$q('#household-card .sub[style]');if(h)h.textContent='אין חיבור — הקישור יופיע כשהחיבור יחזור.'});
    const share=$q('#share-invite');if(share)share.onclick=async()=>{const url=inviteLink();try{if(navigator.share){await navigator.share({title:'CASA',text:`הצטרפות ${toHouse(C.hh.name)} ב־CASA`,url});return}}catch(e){if(e?.name==='AbortError')return}try{await navigator.clipboard.writeText(url);toast('הקישור הועתק')}catch{toast('אפשר להעתיק את הקישור שמוצג')}};
    const cp=$q('#copy-invite-cloud');if(cp)cp.onclick=async()=>{try{await navigator.clipboard.writeText(inviteLink());toast('הקישור הועתק')}catch{toast('אפשר להעתיק את הקישור שמוצג')}};
    const rn=$q('#renew-invite');if(rn)rn.onclick=async()=>{try{if(C.invite)await sb.from('invites').update({revoked_at:new Date().toISOString()}).eq('token',C.invite.token);C.invite=null;await ensureInvite(true);render();toast('נוצר קישור חדש. הקודם בוטל')}catch{toast('אין חיבור כרגע')}};
    const mg=$q('#migrate-local');if(mg)mg.onclick=()=>{let demo;try{demo=JSON.parse(localStorage.getItem(DEMO_KEY))}catch{}if(!demo){toast('לא נמצאו נתונים');return}
      const remap=el=>{if(!el||typeof el!=='object'||!('who' in el))return el;return{...el,who:whoOut(el.who)}};
      let n=0;for(const s of ARR){if(!Array.isArray(demo[s]))continue;const have=new Set((data[s]||[]).map(itemId));for(const el of demo[s]){const mapped=WHO.includes(s)?remap(el):el;const id=itemId(mapped);if(s==='menu'){const ix=data.menu.findIndex(m=>itemId(m)===id);if(ix>=0){data.menu[ix]=mapped;continue}}if(!have.has(id)){(data[s]=data[s]||[]).push(mapped);n++}}}
      if(demo.freq)for(const k in demo.freq)data.freq[k]=Math.max(data.freq[k]||0,demo.freq[k]);
      save();localStorage.setItem('casa-migrated:'+C.hh.id,'1');render();toast(`${n} פריטים הועברו לבית המשותף`)};
    const dm=$q('#dismiss-migrate');if(dm)dm.onclick=()=>{localStorage.setItem('casa-migrate-dismissed:'+C.hh.id,'1');render()};
    const sgo=$q('#sign-out');if(sgo)sgo.onclick=()=>C.signOut();
  }
  C.bindPhotos();
};
})();
