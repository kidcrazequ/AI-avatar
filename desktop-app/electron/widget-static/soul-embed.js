var SoulEmbed=function(Z){"use strict";var z,m,he,A,be,me,ge,ee,j,F,ve,te,re,ne,B={},q=[],Ve=/acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i,G=Array.isArray;function I(t,e){for(var r in e)t[r]=e[r];return t}function oe(t){t&&t.parentNode&&t.parentNode.removeChild(t)}function ye(t,e,r){var o,i,n,l={};for(n in e)n=="key"?o=e[n]:n=="ref"?i=e[n]:l[n]=e[n];if(arguments.length>2&&(l.children=arguments.length>3?z.call(arguments,2):r),typeof t=="function"&&t.defaultProps!=null)for(n in t.defaultProps)l[n]===void 0&&(l[n]=t.defaultProps[n]);return K(t,l,o,i,null)}function K(t,e,r,o,i){var n={type:t,props:e,key:r,ref:o,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:i==null?++he:i,__i:-1,__u:0};return i==null&&m.vnode!=null&&m.vnode(n),n}function Y(t){return t.children}function J(t,e){this.props=t,this.context=e}function N(t,e){if(e==null)return t.__?N(t.__,t.__i+1):null;for(var r;e<t.__k.length;e++)if((r=t.__k[e])!=null&&r.__e!=null)return r.__e;return typeof t.type=="function"?N(t):null}function Xe(t){if(t.__P&&t.__d){var e=t.__v,r=e.__e,o=[],i=[],n=I({},e);n.__v=e.__v+1,m.vnode&&m.vnode(n),ie(t.__P,n,e,t.__n,t.__P.namespaceURI,32&e.__u?[r]:null,o,r==null?N(e):r,!!(32&e.__u),i),n.__v=e.__v,n.__.__k[n.__i]=n,Ee(o,n,i),e.__e=e.__=null,n.__e!=r&&xe(n)}}function xe(t){if((t=t.__)!=null&&t.__c!=null)return t.__e=t.__c.base=null,t.__k.some(function(e){if(e!=null&&e.__e!=null)return t.__e=t.__c.base=e.__e}),xe(t)}function we(t){(!t.__d&&(t.__d=!0)&&A.push(t)&&!Q.__r++||be!=m.debounceRendering)&&((be=m.debounceRendering)||me)(Q)}function Q(){try{for(var t,e=1;A.length;)A.length>e&&A.sort(ge),t=A.shift(),e=A.length,Xe(t)}finally{A.length=Q.__r=0}}function ke(t,e,r,o,i,n,l,a,c,_,u){var s,d,f,v,$,y,h,b=o&&o.__k||q,E=e.length;for(c=Ze(r,e,b,c,E),s=0;s<E;s++)(f=r.__k[s])!=null&&(d=f.__i!=-1&&b[f.__i]||B,f.__i=s,y=ie(t,f,d,i,n,l,a,c,_,u),v=f.__e,f.ref&&d.ref!=f.ref&&(d.ref&&_e(d.ref,null,f),u.push(f.ref,f.__c||v,f)),$==null&&v!=null&&($=v),(h=!!(4&f.__u))||d.__k===f.__k?(c=Se(f,c,t,h),h&&d.__e&&(d.__e=null)):typeof f.type=="function"&&y!==void 0?c=y:v&&(c=v.nextSibling),f.__u&=-7);return r.__e=$,c}function Ze(t,e,r,o,i){var n,l,a,c,_,u=r.length,s=u,d=0;for(t.__k=new Array(i),n=0;n<i;n++)(l=e[n])!=null&&typeof l!="boolean"&&typeof l!="function"?(typeof l=="string"||typeof l=="number"||typeof l=="bigint"||l.constructor==String?l=t.__k[n]=K(null,l,null,null,null):G(l)?l=t.__k[n]=K(Y,{children:l},null,null,null):l.constructor===void 0&&l.__b>0?l=t.__k[n]=K(l.type,l.props,l.key,l.ref?l.ref:null,l.__v):t.__k[n]=l,c=n+d,l.__=t,l.__b=t.__b+1,a=null,(_=l.__i=et(l,r,c,s))!=-1&&(s--,(a=r[_])&&(a.__u|=2)),a==null||a.__v==null?(_==-1&&(i>u?d--:i<u&&d++),typeof l.type!="function"&&(l.__u|=4)):_!=c&&(_==c-1?d--:_==c+1?d++:(_>c?d--:d++,l.__u|=4))):t.__k[n]=null;if(s)for(n=0;n<u;n++)(a=r[n])!=null&&!(2&a.__u)&&(a.__e==o&&(o=N(a)),Me(a,a));return o}function Se(t,e,r,o){var i,n;if(typeof t.type=="function"){for(i=t.__k,n=0;i&&n<i.length;n++)i[n]&&(i[n].__=t,e=Se(i[n],e,r,o));return e}t.__e!=e&&(o&&(e&&t.type&&!e.parentNode&&(e=N(t)),r.insertBefore(t.__e,e||null)),e=t.__e);do e=e&&e.nextSibling;while(e!=null&&e.nodeType==8);return e}function et(t,e,r,o){var i,n,l,a=t.key,c=t.type,_=e[r],u=_!=null&&(2&_.__u)==0;if(_===null&&a==null||u&&a==_.key&&c==_.type)return r;if(o>(u?1:0)){for(i=r-1,n=r+1;i>=0||n<e.length;)if((_=e[l=i>=0?i--:n++])!=null&&!(2&_.__u)&&a==_.key&&c==_.type)return l}return-1}function $e(t,e,r){e[0]=="-"?t.setProperty(e,r==null?"":r):t[e]=r==null?"":typeof r!="number"||Ve.test(e)?r:r+"px"}function V(t,e,r,o,i){var n,l;e:if(e=="style")if(typeof r=="string")t.style.cssText=r;else{if(typeof o=="string"&&(t.style.cssText=o=""),o)for(e in o)r&&e in r||$e(t.style,e,"");if(r)for(e in r)o&&r[e]==o[e]||$e(t.style,e,r[e])}else if(e[0]=="o"&&e[1]=="n")n=e!=(e=e.replace(ve,"$1")),l=e.toLowerCase(),e=l in t||e=="onFocusOut"||e=="onFocusIn"?l.slice(2):e.slice(2),t.l||(t.l={}),t.l[e+n]=r,r?o?r[F]=o[F]:(r[F]=te,t.addEventListener(e,n?ne:re,n)):t.removeEventListener(e,n?ne:re,n);else{if(i=="http://www.w3.org/2000/svg")e=e.replace(/xlink(H|:h)/,"h").replace(/sName$/,"s");else if(e!="width"&&e!="height"&&e!="href"&&e!="list"&&e!="form"&&e!="tabIndex"&&e!="download"&&e!="rowSpan"&&e!="colSpan"&&e!="role"&&e!="popover"&&e in t)try{t[e]=r==null?"":r;break e}catch(a){}typeof r=="function"||(r==null||r===!1&&e[4]!="-"?t.removeAttribute(e):t.setAttribute(e,e=="popover"&&r==1?"":r))}}function Ce(t){return function(e){if(this.l){var r=this.l[e.type+t];if(e[j]==null)e[j]=te++;else if(e[j]<r[F])return;return r(m.event?m.event(e):e)}}}function ie(t,e,r,o,i,n,l,a,c,_){var u,s,d,f,v,$,y,h,b,E,M,p,H,S,U,w=e.type;if(e.constructor!==void 0)return null;128&r.__u&&(c=!!(32&r.__u),n=[a=e.__e=r.__e]),(u=m.__b)&&u(e);e:if(typeof w=="function")try{if(h=e.props,b=w.prototype&&w.prototype.render,E=(u=w.contextType)&&o[u.__c],M=u?E?E.props.value:u.__:o,r.__c?y=(s=e.__c=r.__c).__=s.__E:(b?e.__c=s=new w(h,M):(e.__c=s=new J(h,M),s.constructor=w,s.render=rt),E&&E.sub(s),s.state||(s.state={}),s.__n=o,d=s.__d=!0,s.__h=[],s._sb=[]),b&&s.__s==null&&(s.__s=s.state),b&&w.getDerivedStateFromProps!=null&&(s.__s==s.state&&(s.__s=I({},s.__s)),I(s.__s,w.getDerivedStateFromProps(h,s.__s))),f=s.props,v=s.state,s.__v=e,d)b&&w.getDerivedStateFromProps==null&&s.componentWillMount!=null&&s.componentWillMount(),b&&s.componentDidMount!=null&&s.__h.push(s.componentDidMount);else{if(b&&w.getDerivedStateFromProps==null&&h!==f&&s.componentWillReceiveProps!=null&&s.componentWillReceiveProps(h,M),e.__v==r.__v||!s.__e&&s.shouldComponentUpdate!=null&&s.shouldComponentUpdate(h,s.__s,M)===!1){e.__v!=r.__v&&(s.props=h,s.state=s.__s,s.__d=!1),e.__e=r.__e,e.__k=r.__k,e.__k.some(function(P){P&&(P.__=e)}),q.push.apply(s.__h,s._sb),s._sb=[],s.__h.length&&l.push(s);break e}s.componentWillUpdate!=null&&s.componentWillUpdate(h,s.__s,M),b&&s.componentDidUpdate!=null&&s.__h.push(function(){s.componentDidUpdate(f,v,$)})}if(s.context=M,s.props=h,s.__P=t,s.__e=!1,p=m.__r,H=0,b)s.state=s.__s,s.__d=!1,p&&p(e),u=s.render(s.props,s.state,s.context),q.push.apply(s.__h,s._sb),s._sb=[];else do s.__d=!1,p&&p(e),u=s.render(s.props,s.state,s.context),s.state=s.__s;while(s.__d&&++H<25);s.state=s.__s,s.getChildContext!=null&&(o=I(I({},o),s.getChildContext())),b&&!d&&s.getSnapshotBeforeUpdate!=null&&($=s.getSnapshotBeforeUpdate(f,v)),S=u!=null&&u.type===Y&&u.key==null?Te(u.props.children):u,a=ke(t,G(S)?S:[S],e,r,o,i,n,l,a,c,_),s.base=e.__e,e.__u&=-161,s.__h.length&&l.push(s),y&&(s.__E=s.__=null)}catch(P){if(e.__v=null,c||n!=null)if(P.then){for(e.__u|=c?160:128;a&&a.nodeType==8&&a.nextSibling;)a=a.nextSibling;n[n.indexOf(a)]=null,e.__e=a}else{for(U=n.length;U--;)oe(n[U]);se(e)}else e.__e=r.__e,e.__k=r.__k,P.then||se(e);m.__e(P,e,r)}else n==null&&e.__v==r.__v?(e.__k=r.__k,e.__e=r.__e):a=e.__e=tt(r.__e,e,r,o,i,n,l,c,_);return(u=m.diffed)&&u(e),128&e.__u?void 0:a}function se(t){t&&(t.__c&&(t.__c.__e=!0),t.__k&&t.__k.some(se))}function Ee(t,e,r){for(var o=0;o<r.length;o++)_e(r[o],r[++o],r[++o]);m.__c&&m.__c(e,t),t.some(function(i){try{t=i.__h,i.__h=[],t.some(function(n){n.call(i)})}catch(n){m.__e(n,i.__v)}})}function Te(t){return typeof t!="object"||t==null||t.__b>0?t:G(t)?t.map(Te):I({},t)}function tt(t,e,r,o,i,n,l,a,c){var _,u,s,d,f,v,$,y=r.props||B,h=e.props,b=e.type;if(b=="svg"?i="http://www.w3.org/2000/svg":b=="math"?i="http://www.w3.org/1998/Math/MathML":i||(i="http://www.w3.org/1999/xhtml"),n!=null){for(_=0;_<n.length;_++)if((f=n[_])&&"setAttribute"in f==!!b&&(b?f.localName==b:f.nodeType==3)){t=f,n[_]=null;break}}if(t==null){if(b==null)return document.createTextNode(h);t=document.createElementNS(i,b,h.is&&h),a&&(m.__m&&m.__m(e,n),a=!1),n=null}if(b==null)y===h||a&&t.data==h||(t.data=h);else{if(n=n&&z.call(t.childNodes),!a&&n!=null)for(y={},_=0;_<t.attributes.length;_++)y[(f=t.attributes[_]).name]=f.value;for(_ in y)f=y[_],_=="dangerouslySetInnerHTML"?s=f:_=="children"||_ in h||_=="value"&&"defaultValue"in h||_=="checked"&&"defaultChecked"in h||V(t,_,null,f,i);for(_ in h)f=h[_],_=="children"?d=f:_=="dangerouslySetInnerHTML"?u=f:_=="value"?v=f:_=="checked"?$=f:a&&typeof f!="function"||y[_]===f||V(t,_,f,y[_],i);if(u)a||s&&(u.__html==s.__html||u.__html==t.innerHTML)||(t.innerHTML=u.__html),e.__k=[];else if(s&&(t.innerHTML=""),ke(e.type=="template"?t.content:t,G(d)?d:[d],e,r,o,b=="foreignObject"?"http://www.w3.org/1999/xhtml":i,n,l,n?n[0]:r.__k&&N(r,0),a,c),n!=null)for(_=n.length;_--;)oe(n[_]);a||(_="value",b=="progress"&&v==null?t.removeAttribute("value"):v!=null&&(v!==t[_]||b=="progress"&&!v||b=="option"&&v!=y[_])&&V(t,_,v,y[_],i),_="checked",$!=null&&$!=t[_]&&V(t,_,$,y[_],i))}return t}function _e(t,e,r){try{if(typeof t=="function"){var o=typeof t.__u=="function";o&&t.__u(),o&&e==null||(t.__u=t(e))}else t.current=e}catch(i){m.__e(i,r)}}function Me(t,e,r){var o,i;if(m.unmount&&m.unmount(t),(o=t.ref)&&(o.current&&o.current!=t.__e||_e(o,null,e)),(o=t.__c)!=null){if(o.componentWillUnmount)try{o.componentWillUnmount()}catch(n){m.__e(n,e)}o.base=o.__P=null}if(o=t.__k)for(i=0;i<o.length;i++)o[i]&&Me(o[i],e,r||typeof t.type!="function");r||oe(t.__e),t.__c=t.__=t.__e=void 0}function rt(t,e,r){return this.constructor(t,r)}function Pe(t,e,r){var o,i,n,l;e==document&&(e=document.documentElement),m.__&&m.__(t,e),i=(o=!1)?null:e.__k,n=[],l=[],ie(e,t=e.__k=ye(Y,null,[t]),i||B,B,e.namespaceURI,i?null:e.firstChild?z.call(e.childNodes):null,n,i?i.__e:e.firstChild,o,l),Ee(n,t,l)}z=q.slice,m={__e:function(t,e,r,o){for(var i,n,l;e=e.__;)if((i=e.__c)&&!i.__)try{if((n=i.constructor)&&n.getDerivedStateFromError!=null&&(i.setState(n.getDerivedStateFromError(t)),l=i.__d),i.componentDidCatch!=null&&(i.componentDidCatch(t,o||{}),l=i.__d),l)return i.__E=i}catch(a){t=a}throw t}},he=0,J.prototype.setState=function(t,e){var r;r=this.__s!=null&&this.__s!=this.state?this.__s:this.__s=I({},this.state),typeof t=="function"&&(t=t(I({},r),this.props)),t&&I(r,t),t!=null&&this.__v&&(e&&this._sb.push(e),we(this))},J.prototype.forceUpdate=function(t){this.__v&&(this.__e=!0,t&&this.__h.push(t),we(this))},J.prototype.render=Y,A=[],me=typeof Promise=="function"?Promise.prototype.then.bind(Promise.resolve()):setTimeout,ge=function(t,e){return t.__v.__b-e.__v.__b},Q.__r=0,ee=Math.random().toString(8),j="__d"+ee,F="__a"+ee,ve=/(PointerCapture)$|Capture$/i,te=0,re=Ce(!1),ne=Ce(!0);var nt=0;function k(t,e,r,o,i,n){e||(e={});var l,a,c=e;if("ref"in c)for(a in c={},e)a=="ref"?l=e[a]:c[a]=e[a];var _={type:t,props:c,key:r,ref:l,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:--nt,__i:-1,__u:0,__source:i,__self:n};if(typeof t=="function"&&(l=t.defaultProps))for(a in l)c[a]===void 0&&(c[a]=l[a]);return m.vnode&&m.vnode(_),_}var R,g,le,Ie,D=0,Ae=[],x=m,He=x.__b,Ue=x.__r,Ne=x.diffed,Le=x.__c,Fe=x.unmount,Re=x.__;function ae(t,e){x.__h&&x.__h(g,t,D||e),D=0;var r=g.__H||(g.__H={__:[],__h:[]});return t>=r.__.length&&r.__.push({}),r.__[t]}function W(t){return D=1,ot(je,t)}function ot(t,e,r){var o=ae(R++,2);if(o.t=t,!o.__c&&(o.__=[je(void 0,e),function(a){var c=o.__N?o.__N[0]:o.__[0],_=o.t(c,a);c!==_&&(o.__N=[_,o.__[1]],o.__c.setState({}))}],o.__c=g,!g.__f)){var i=function(a,c,_){if(!o.__c.__H)return!0;var u=o.__c.__H.__.filter(function(d){return d.__c});if(u.every(function(d){return!d.__N}))return!n||n.call(this,a,c,_);var s=o.__c.props!==a;return u.some(function(d){if(d.__N){var f=d.__[0];d.__=d.__N,d.__N=void 0,f!==d.__[0]&&(s=!0)}}),n&&n.call(this,a,c,_)||s};g.__f=!0;var n=g.shouldComponentUpdate,l=g.componentWillUpdate;g.componentWillUpdate=function(a,c,_){if(this.__e){var u=n;n=void 0,i(a,c,_),n=u}l&&l.call(this,a,c,_)},g.shouldComponentUpdate=i}return o.__N||o.__}function De(t,e){var r=ae(R++,3);!x.__s&&ze(r.__H,e)&&(r.__=t,r.u=e,g.__H.__h.push(r))}function We(t){return D=5,ce(function(){return{current:t}},[])}function ce(t,e){var r=ae(R++,7);return ze(r.__H,e)&&(r.__=t(),r.__H=e,r.__h=t),r.__}function ue(t,e){return D=8,ce(function(){return t},e)}function it(){for(var t;t=Ae.shift();){var e=t.__H;if(t.__P&&e)try{e.__h.some(X),e.__h.some(de),e.__h=[]}catch(r){e.__h=[],x.__e(r,t.__v)}}}x.__b=function(t){g=null,He&&He(t)},x.__=function(t,e){t&&e.__k&&e.__k.__m&&(t.__m=e.__k.__m),Re&&Re(t,e)},x.__r=function(t){Ue&&Ue(t),R=0;var e=(g=t.__c).__H;e&&(le===g?(e.__h=[],g.__h=[],e.__.some(function(r){r.__N&&(r.__=r.__N),r.u=r.__N=void 0})):(e.__h.some(X),e.__h.some(de),e.__h=[],R=0)),le=g},x.diffed=function(t){Ne&&Ne(t);var e=t.__c;e&&e.__H&&(e.__H.__h.length&&(Ae.push(e)!==1&&Ie===x.requestAnimationFrame||((Ie=x.requestAnimationFrame)||st)(it)),e.__H.__.some(function(r){r.u&&(r.__H=r.u),r.u=void 0})),le=g=null},x.__c=function(t,e){e.some(function(r){try{r.__h.some(X),r.__h=r.__h.filter(function(o){return!o.__||de(o)})}catch(o){e.some(function(i){i.__h&&(i.__h=[])}),e=[],x.__e(o,r.__v)}}),Le&&Le(t,e)},x.unmount=function(t){Fe&&Fe(t);var e,r=t.__c;r&&r.__H&&(r.__H.__.some(function(o){try{X(o)}catch(i){e=i}}),r.__H=void 0,e&&x.__e(e,r.__v))};var Oe=typeof requestAnimationFrame=="function";function st(t){var e,r=function(){clearTimeout(o),Oe&&cancelAnimationFrame(e),setTimeout(t)},o=setTimeout(r,35);Oe&&(e=requestAnimationFrame(r))}function X(t){var e=g,r=t.__c;typeof r=="function"&&(t.__c=void 0,r()),g=e}function de(t){var e=g;t.__c=t.__(),g=e}function ze(t,e){return!t||t.length!==e.length||e.some(function(r,o){return r!==t[o]})}function je(t,e){return typeof e=="function"?e(t):e}class L extends Error{constructor(e,r){super(r),this.name="ApiError",this.status=e}}class Be extends L{constructor(e,r="rate_limited"){super(429,r),this.name="RateLimitError",this.retryAfterSec=e}}class _t extends L{constructor(e,r){super(e,r),this.name="ServerError"}}const lt=3e4;async function at(t,e){const r=new AbortController,o=window.setTimeout(()=>r.abort(),1e4);try{const i=await fetch(`${qe(t)}/embed/${encodeURIComponent(e)}/config`,{method:"GET",signal:r.signal,credentials:"omit",headers:{Accept:"application/json"}});if(!i.ok)throw new L(i.status,`config fetch failed: ${i.status}`);const n=await i.json();if(!n||typeof n.embedId!="string"||typeof n.avatarId!="string")throw new L(500,"config payload invalid");return{embedId:n.embedId,avatarId:n.avatarId,name:typeof n.name=="string"?n.name:"Soul Embed",greeting:typeof n.greeting=="string"?n.greeting:null,rateLimitPerMin:typeof n.rateLimitPerMin=="number"?n.rateLimitPerMin:30}}finally{window.clearTimeout(o)}}async function ct(t,e,r,o,i,n){var c;const l=new AbortController,a=window.setTimeout(()=>l.abort(),lt);try{const _={"Content-Type":"application/json",Accept:"text/event-stream"};o&&(_["X-Soul-Conversation-Id"]=o);const u=await fetch(`${qe(t)}/api/embed/${encodeURIComponent(e)}/messages`,{method:"POST",credentials:"omit",signal:l.signal,headers:_,body:JSON.stringify({messages:[{role:"user",content:r}],stream:!0})}),s=u.headers.get("X-Soul-Conversation-Id");if(s&&n(s),u.status===429){const d=Number((c=u.headers.get("Retry-After"))!=null?c:"3");throw new Be(Number.isFinite(d)&&d>0?d:3)}if(!u.ok){let d="";try{d=await u.text()}catch(f){d=""}throw new _t(u.status,d||`server error: ${u.status}`)}if(!u.body)throw new L(500,"response has no body");await ut(u.body,i)}finally{window.clearTimeout(a)}}function qe(t){return t.endsWith("/")?t.slice(0,-1):t}async function ut(t,e){const r=t.getReader(),o=new TextDecoder("utf-8");let i="";for(;;){const{value:n,done:l}=await r.read();if(l)break;i+=o.decode(n,{stream:!0});let a;for(;(a=i.indexOf(`

`))!==-1;){const c=i.slice(0,a);i=i.slice(a+2),Ge(c,e)}}i+=o.decode(),i.trim().length>0&&Ge(i,e)}function Ge(t,e){const r=t.split(/\r?\n/),o=[];for(const a of r)if(a.length!==0&&!a.startsWith(":")&&a.startsWith("data:")){const c=a.slice(5).replace(/^ /,"");o.push(c)}if(o.length===0)return;const i=o.join(`
`);if(i==="[DONE]")return;let n=null;try{n=JSON.parse(i)}catch(a){return}if(!n)return;const l=n.delta;n.type==="content_block_delta"&&(l==null?void 0:l.type)==="text_delta"&&typeof l.text=="string"&&e(l.text)}function fe(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}function dt(t){const e=t.trim();return e.length===0?null:e.startsWith("http://")||e.startsWith("https://")||e.startsWith("/")||e.startsWith("./")||e.startsWith("../")?e:null}function ft(t){let e=t.replace(/`([^`\n]+?)`/g,(r,o)=>`<code>${o}</code>`);return e=e.replace(/\[([^\]\n]+?)\]\(([^)\s]+?)\)/g,(r,o,i)=>{const n=dt(i);return n?`<a href="${fe(n)}" target="_blank" rel="noopener noreferrer">${o}</a>`:r}),e}function pt(t){if(typeof t!="string"||t.length===0)return"";const e=[],r="\0__SOUL_CODE_BLOCK_",o="__\0";let i=t.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g,(a,c,_)=>{const u=e.length;return e.push(`<pre><code>${fe(_)}</code></pre>`),`${r}${u}${o}`});const n=i.split(/\n{2,}/),l=[];for(const a of n){const c=a.replace(/^\n+|\n+$/g,"");if(c.length===0)continue;if(c.startsWith(r)&&c.endsWith(o)){l.push(c);continue}const _=fe(c).replace(/\n/g,"<br/>"),u=ft(_);l.push(`<p>${u}</p>`)}return i=l.join(""),i=i.replace(new RegExp(`${r.replace(/\u0000/g,"\\u0000")}(\\d+)${o.replace(/\u0000/g,"\\u0000")}`,"g"),(a,c)=>{var _;return(_=e[Number(c)])!=null?_:""}),i}const pe=[1e3,2e3,4e3],ht=3e3;let Ke=0;function Ye(){return Ke+=1,`m_${Date.now().toString(36)}_${Ke}`}function bt(t){var M;const{embedId:e,serverUrl:r}=t,[o,i]=W(null),[n,l]=W([]),[a,c]=W(""),[_,u]=W("idle"),[s,d]=W(""),f=We(null),v=We(null);De(()=>{let p=!1;return at(r,e).then(H=>{p||i(H)}).catch(()=>{p||(u("config_failed"),d("服务暂不可用"))}),()=>{p=!0}},[e,r]),De(()=>{const p=v.current;p&&(p.scrollTop=p.scrollHeight)},[n,_]);const $=ue(async(p,H)=>{await ct(r,e,p,f.current,S=>{l(U=>U.map(w=>w.id===H?{...w,content:w.content+S}:w))},S=>{f.current=S})},[e,r]),y=ue(async()=>{const p=a.trim();if(p.length===0||_==="streaming"||_==="rate_limited"||_==="config_failed")return;c("");const H={id:Ye(),role:"user",content:p},S=Ye(),U={id:S,role:"assistant",content:"",streaming:!0};l(C=>[...C,H,U]),u("streaming"),d("");let w=0,P=null;for(;w<=pe.length;)try{await $(p,S),l(C=>C.map(T=>T.id===S?{...T,streaming:!1}:T)),u("idle"),d("");return}catch(C){if(P=C,C instanceof Be){l(T=>T.filter(O=>O.id!==S)),u("rate_limited"),d(`请稍后再试（${C.retryAfterSec}s）`),window.setTimeout(()=>{u(T=>T==="rate_limited"?"idle":T),d("")},Math.max(ht,C.retryAfterSec*1e3));return}if(C instanceof L&&C.status>=400&&C.status<500&&C.status!==429)break;if(w<pe.length){d("网络错误，正在重试..."),await gt(pe[w]),w++,l(T=>T.map(O=>O.id===S?{...O,content:""}:O));continue}break}l(C=>C.filter(T=>T.id!==S)),u("error");const wt=P instanceof Error?P.message:"未知错误";d(`发送失败：${wt}`)},[a,_,$]),h=ue(p=>{p.key==="Enter"&&!p.shiftKey&&!p.isComposing&&(p.preventDefault(),y())},[y]),b=ce(()=>n.length===0&&(o==null?void 0:o.greeting),[n.length,o==null?void 0:o.greeting]),E=_==="streaming"||_==="rate_limited"||_==="config_failed";return k("div",{class:"root",children:[k("div",{class:"header",children:[k("div",{class:"title",children:(M=o==null?void 0:o.name)!=null?M:"Soul"}),k("div",{class:"powered",children:"powered by Soul"})]}),k("div",{class:"body",ref:v,children:[b?k("div",{class:"greeting",children:o==null?void 0:o.greeting}):null,n.map(p=>k(mt,{message:p},p.id)),_==="config_failed"?k("div",{class:"notice error",children:"服务暂不可用，请稍后再试"}):null,_==="error"?k("div",{class:"notice error",children:s||"发送失败"}):null,_==="rate_limited"?k("div",{class:"notice warn",children:s||"请稍后再试"}):null,_==="streaming"&&s?k("div",{class:"notice warn",children:s}):null]}),k("div",{class:"footer",children:[k("textarea",{value:a,disabled:E,placeholder:E?"请稍候...":"输入消息，Enter 发送",onInput:p=>c(p.currentTarget.value),onKeyDown:h,rows:1}),k("button",{type:"button",disabled:E||a.trim().length===0,onClick:()=>void y(),children:"发送"})]})]})}function mt(t){const{message:e}=t;if(e.role==="user")return k("div",{class:"bubble user",children:e.content});const r=pt(e.content);return k("div",{class:"bubble assistant",children:[k("span",{dangerouslySetInnerHTML:{__html:r}}),e.streaming?k("span",{class:"cursor"}):null]})}function gt(t){return new Promise(e=>window.setTimeout(e,t))}const vt=`
:host {
  all: initial;
  --soul-bg: #ffffff;
  --soul-fg: #1f2937;
  --soul-muted: #6b7280;
  --soul-border: #e5e7eb;
  --soul-bubble-user-bg: #2563eb;
  --soul-bubble-user-fg: #ffffff;
  --soul-bubble-assistant-bg: #f3f4f6;
  --soul-bubble-assistant-fg: #111827;
  --soul-primary: #111827;
  --soul-primary-fg: #ffffff;
  --soul-error: #b91c1c;
  --soul-error-bg: #fef2f2;
  --soul-warn: #92400e;
  --soul-warn-bg: #fef3c7;

  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 360px;
  height: 520px;
  z-index: 2147483000;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--soul-fg);
  contain: layout style;
}

* {
  box-sizing: border-box;
}

.root {
  width: 100%;
  height: 100%;
  background: var(--soul-bg);
  border: 1px solid var(--soul-border);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.12);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.header {
  flex: 0 0 auto;
  padding: 12px 16px;
  border-bottom: 1px solid var(--soul-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--soul-bg);
}

.header .title {
  font-weight: 600;
  font-size: 14px;
  color: var(--soul-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header .powered {
  font-size: 11px;
  color: var(--soul-muted);
}

.body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: #fafafa;
  scrollbar-width: thin;
}

.body::-webkit-scrollbar {
  width: 6px;
}

.body::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.15);
  border-radius: 3px;
}

.greeting {
  align-self: flex-start;
  background: var(--soul-bubble-assistant-bg);
  color: var(--soul-bubble-assistant-fg);
  padding: 8px 12px;
  border-radius: 12px 12px 12px 4px;
  max-width: 80%;
  white-space: pre-wrap;
  word-break: break-word;
}

.bubble {
  max-width: 80%;
  padding: 8px 12px;
  border-radius: 12px;
  word-break: break-word;
  white-space: normal;
}

.bubble.user {
  align-self: flex-end;
  background: var(--soul-bubble-user-bg);
  color: var(--soul-bubble-user-fg);
  border-radius: 12px 12px 4px 12px;
  white-space: pre-wrap;
}

.bubble.assistant {
  align-self: flex-start;
  background: var(--soul-bubble-assistant-bg);
  color: var(--soul-bubble-assistant-fg);
  border-radius: 12px 12px 12px 4px;
}

.bubble.assistant p {
  margin: 0 0 8px 0;
}

.bubble.assistant p:last-child {
  margin-bottom: 0;
}

.bubble.assistant a {
  color: var(--soul-bubble-user-bg);
  text-decoration: underline;
}

.bubble.assistant code {
  background: rgba(0, 0, 0, 0.06);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12.5px;
}

.bubble.assistant pre {
  background: #0f172a;
  color: #e2e8f0;
  padding: 10px 12px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 6px 0;
  font-size: 12.5px;
}

.bubble.assistant pre code {
  background: transparent;
  padding: 0;
  color: inherit;
  font-size: inherit;
}

.cursor {
  display: inline-block;
  width: 8px;
  height: 14px;
  background: currentColor;
  margin-left: 2px;
  vertical-align: -2px;
  animation: soul-blink 1s step-end infinite;
}

@keyframes soul-blink {
  50% { opacity: 0; }
}

.notice {
  align-self: stretch;
  text-align: center;
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
}

.notice.error {
  background: var(--soul-error-bg);
  color: var(--soul-error);
}

.notice.warn {
  background: var(--soul-warn-bg);
  color: var(--soul-warn);
}

.footer {
  flex: 0 0 auto;
  border-top: 1px solid var(--soul-border);
  padding: 8px;
  display: flex;
  gap: 6px;
  align-items: flex-end;
  background: var(--soul-bg);
}

.footer textarea {
  flex: 1 1 auto;
  resize: none;
  border: 1px solid var(--soul-border);
  border-radius: 8px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.4;
  outline: none;
  max-height: 96px;
  min-height: 36px;
  color: var(--soul-fg);
  background: #ffffff;
}

.footer textarea:focus {
  border-color: var(--soul-bubble-user-bg);
}

.footer textarea:disabled {
  background: #f9fafb;
  color: var(--soul-muted);
  cursor: not-allowed;
}

.footer button {
  flex: 0 0 auto;
  background: var(--soul-primary);
  color: var(--soul-primary-fg);
  border: 0;
  border-radius: 8px;
  padding: 0 14px;
  height: 36px;
  font-size: 14px;
  cursor: pointer;
  font-family: inherit;
}

.footer button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 480px) {
  :host {
    bottom: 0;
    right: 0;
    width: 100vw;
    height: 100vh;
  }
  .root {
    border-radius: 0;
    border-width: 0;
  }
}
`;class yt extends HTMLElement{constructor(){super(...arguments),this.shadow=null,this.mountPoint=null}connectedCallback(){var l,a,c,_;if(this.shadow)return;const e=(a=(l=this.getAttribute("embed-id"))!=null?l:this.dataset.embedId)!=null?a:"",o=((_=(c=this.getAttribute("data-server"))!=null?c:this.dataset.server)!=null?_:"")||Qe()||"";this.shadow=this.attachShadow({mode:"open"});const i=document.createElement("style");i.textContent=vt,this.shadow.appendChild(i);const n=document.createElement("div");if(n.className="soul-mount",this.shadow.appendChild(n),this.mountPoint=n,e.length===0||o.length===0){const u=document.createElement("div");u.style.cssText="padding:12px;font:13px -apple-system,sans-serif;color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;",u.textContent="[soul-embed] 缺少必填参数：embed-id 或 data-server",n.appendChild(u);return}Pe(ye(bt,{embedId:e,serverUrl:o}),n)}disconnectedCallback(){if(this.mountPoint){try{Pe(null,this.mountPoint)}catch(e){}this.mountPoint=null}this.shadow=null}}let Je=null;function xt(){if(typeof document=="undefined")return;const t=document.currentScript;if(t&&t.src)try{const e=new URL(t.src);Je=`${e.protocol}//${e.host}`}catch(e){}}function Qe(){return Je}return typeof window!="undefined"&&(xt(),customElements.get("soul-embed")||customElements.define("soul-embed",yt)),Z.getFallbackServerUrl=Qe,Object.defineProperty(Z,Symbol.toStringTag,{value:"Module"}),Z}({});
