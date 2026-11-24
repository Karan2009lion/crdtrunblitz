const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./boot-jt8Tm_sf.js","./react-DnxA9v5e.js","./charts-DBqfzYwe.js"])))=>i.map(i=>d[i]);
(function(){const s=document.createElement("link").relList;if(s&&s.supports&&s.supports("modulepreload"))return;for(const e of document.querySelectorAll('link[rel="modulepreload"]'))c(e);new MutationObserver(e=>{for(const t of e)if(t.type==="childList")for(const n of t.addedNodes)n.tagName==="LINK"&&n.rel==="modulepreload"&&c(n)}).observe(document,{childList:!0,subtree:!0});function i(e){const t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),e.crossOrigin==="use-credentials"?t.credentials="include":e.crossOrigin==="anonymous"?t.credentials="omit":t.credentials="same-origin",t}function c(e){if(e.ep)return;e.ep=!0;const t=i(e);fetch(e.href,t)}})();const E="modulepreload",O=function(r,s){return new URL(r,s).href},w={},q=function(s,i,c){let e=Promise.resolve();if(i&&i.length>0){let P=function(a){return Promise.all(a.map(u=>Promise.resolve(u).then(d=>({status:"fulfilled",value:d}),d=>({status:"rejected",reason:d}))))};const n=document.getElementsByTagName("link"),o=document.querySelector("meta[property=csp-nonce]"),v=o?.nonce||o?.getAttribute("nonce");e=P(i.map(a=>{if(a=O(a,c),a in w)return;w[a]=!0;const u=a.endsWith(".css"),d=u?'[rel="stylesheet"]':"";if(c)for(let f=n.length-1;f>=0;f--){const m=n[f];if(m.href===a&&(!u||m.rel==="stylesheet"))return}else if(document.querySelector(`link[href="${a}"]${d}`))return;const l=document.createElement("link");if(l.rel=u?"stylesheet":E,u||(l.as="script"),l.crossOrigin="",l.href=a,v&&l.setAttribute("nonce",v),document.head.appendChild(l),u)return new Promise((f,m)=>{l.addEventListener("load",f),l.addEventListener("error",()=>m(new Error(`Unable to preload CSS for ${a}`)))})}))}function t(n){const o=new Event("vite:preloadError",{cancelable:!0});if(o.payload=n,window.dispatchEvent(o),!o.defaultPrevented)throw n}return e.then(n=>{for(const o of n||[])o.status==="rejected"&&t(o.reason);return s().catch(t)})},b="crdtrade-login",y="b46bc4e272e54dd513c8d523ec09702f51ee1bc5892a448d8022f0f18b56ac79".trim().toLowerCase()||"";async function C(r){const s=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(r));return[...new Uint8Array(s)].map(i=>i.toString(16).padStart(2,"0")).join("")}const I=()=>{try{return localStorage.getItem(b)===y}catch{return!1}};function T(){try{localStorage.removeItem(b)}catch{}location.reload()}function A(r){return!y||I()?Promise.resolve():new Promise(s=>{r.innerHTML=`
      <main class="login">
        <form class="login-card" autocomplete="on">
          <div class="login-brand">CRDTrade</div>
          <h1>Sign in</h1>
          <label class="field">
            <span class="field-label">User name</span>
            <span class="input-wrap"><input id="login-user" name="username" autocomplete="username" required /></span>
          </label>
          <label class="field">
            <span class="field-label">Password</span>
            <span class="input-wrap"><input id="login-pass" name="password" type="password" autocomplete="current-password" required /></span>
          </label>
          <p class="error-text" id="login-error" role="alert" hidden></p>
          <button class="btn btn-buy" type="submit">Sign in</button>
          <p class="hint">Paper money only. No real orders are sent from this website.</p>
        </form>
      </main>`;const i=r.querySelector("form"),c=r.querySelector("#login-user"),e=r.querySelector("#login-pass"),t=r.querySelector("#login-error");c.focus(),i.addEventListener("submit",async n=>{n.preventDefault();const o=await C(`crdtrade:${c.value.trim().toLowerCase()}:${e.value}`);if(o!==y){t.textContent="That user name and password don’t match. Check them and try again.",t.hidden=!1,e.select();return}try{localStorage.setItem(b,o)}catch{}s()})})}const S="crdtrade-bot",g=document.getElementById("root"),L=()=>new Promise(()=>{});async function p(){await A(g),g.replaceChildren(),await q(()=>import("./boot-jt8Tm_sf.js"),__vite__mapDeps([0,1,2]),import.meta.url)}function N(){g.innerHTML=`
    <main class="one-tab" role="status">
      <h1>CRDTrade is already open in another tab</h1>
      <p>Only one tab can run the paper bot, so the test keeps a single account. Switch to the other tab.</p>
      <p class="muted">If you close the other tab, this one takes over automatically.</p>
    </main>`}const h=typeof navigator<"u"?navigator.locks:void 0;h?h.request(S,{ifAvailable:!0},async r=>{if(r)return await p(),L();N(),h.request(S,async()=>(await p(),L()))}):p();export{y as L,T as s};
