const n=document.getElementById('mainNav');addEventListener('scroll',()=>n.classList.toggle('scrolled',scrollY>60));
const b=document.getElementById('burger'),m=document.getElementById('mmenu');b.onclick=()=>m.classList.toggle('open');
const T=document.querySelectorAll('.theme-dot');function setT(t){document.body.className=t;T.forEach(d=>d.classList.toggle('active',d.dataset.theme===t));try{localStorage.setItem('hv-theme',t)}catch(e){}}
T.forEach(d=>d.onclick=()=>setT(d.dataset.theme));try{const s=localStorage.getItem('hv-theme');if(s)setT(s)}catch(e){}
const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.style.opacity=1;e.target.style.transform='none'}}),{threshold:.08});
document.querySelectorAll('.acard,.pk,.amenity-item,.review-card,.room-card').forEach(e=>{e.style.cssText+='opacity:0;transform:translateY(24px);transition:opacity .5s,transform .5s';io.observe(e)});