const firebaseConfig = {
  apiKey: "AIzaSyCiyrnmMGL_ZG7Gn1sij5lwMvyV1BT3Tu8",
  authDomain: "chamados-esim.firebaseapp.com",
  projectId: "chamados-esim",
  storageBucket: "chamados-esim.firebasestorage.app",
  messagingSenderId: "254861458351",
  appId: "1:254861458351:web:a662d5606f785ddefbcd5a"
};

/* ================= PERMISSÕES =================
   ADMINS: veem e gerenciam TODOS os chamados.
   CATEGORIAS: a responsável de Chip (Maria Julia) recebe e gerencia os chamados de Chip.
   Qualquer outra pessoa logada pode abrir chamados e acompanha apenas os que ela mesma abriu.
   (As mesmas regras precisam estar no Firestore — veja o arquivo firestore.rules.) */
const ADMINS = [
  "agnes.angelim@igreenenergy.com.br",
  "anacarolina.araujo@igreenenergy.com.br"
];
const CATEGORIAS = {
  chip: { label: "Chip", icone: "📶", responsavelEmail: "mariajulia.mendes@igreenenergy.com.br", responsavelNome: "Maria Julia" }
};

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  setPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, addDoc, doc, setDoc, getDoc, updateDoc,
  onSnapshot, query, where, orderBy, serverTimestamp, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* A sessão fica só na aba atual — fechou a aba ou o navegador, precisa logar de novo. */
setPersistence(auth, browserSessionPersistence);

/* ---------------- Helpers ---------------- */
const $ = (id) => document.getElementById(id);
const STATUS_LABEL = { aberto: "Em aberto", analise: "Em análise", feito: "Feito" };
const STATUS_ORDER = ["aberto", "analise", "feito"];

function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function tsMs(ts){
  if(!ts) return Date.now(); // gravação ainda pendente = acabou de ser criado
  return ts.toMillis ? ts.toMillis() : new Date(ts).getTime();
}
function fmtData(ts){
  if(!ts) return "agora";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'});
}
function fmtCurto(iso){
  return new Date(iso).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
}
function initials(name){
  if(!name) return "?";
  return name.trim().split(/\s+/).slice(0,2).map(w=>w[0].toUpperCase()).join("");
}
function beep(){
  try{
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = "sine"; o.frequency.value = 740;
    o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime+0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+0.35);
    o.start(); o.stop(ctx.currentTime+0.36);
  }catch(e){}
}
function toast(title, body, kind="aberto"){
  const el = document.createElement("div");
  el.className = "toast";
  el.style.borderLeftColor = kind==="aberto" ? "var(--aberto)" : kind==="analise" ? "var(--analise)" : "var(--feito)";
  el.innerHTML = `<b>${title}</b>${body}`;
  $("toastStack").appendChild(el);
  setTimeout(()=>el.remove(), 6000);
}
function catInfo(cat){ return CATEGORIAS[cat] || null; }

/* ---------------- TEMA CLARO / ESCURO ---------------- */
function aplicarTema(tema){
  document.documentElement.setAttribute("data-theme", tema);
  try{ localStorage.setItem("tema", tema); }catch(e){}
  document.querySelectorAll("[data-theme-toggle]").forEach(b=>{
    b.textContent = tema === "dark" ? "☀" : "☾";
    b.title = tema === "dark" ? "Mudar para modo claro" : "Mudar para modo escuro";
  });
}
aplicarTema(document.documentElement.getAttribute("data-theme") || "light");
document.querySelectorAll("[data-theme-toggle]").forEach(b=>{
  b.addEventListener("click", ()=>{
    const atual = document.documentElement.getAttribute("data-theme");
    aplicarTema(atual === "dark" ? "light" : "dark");
  });
});

/* ---------------- Estado ---------------- */
let currentUser = null;
let currentUserProfile = null;
let activeFilter = "todos";
let searchTerm = "";
let allTickets = [];
let unreadCount = 0;
let uploadedEvidence = null; // {url, tipo} — opcional
let commentCounts = {};
let unsubscribers = [];

/* ---------------- PERFIL / PERMISSÕES ---------------- */
const meuEmail = () => (currentUser?.email || "").toLowerCase();
function souAdmin(){ return ADMINS.includes(meuEmail()); }
function minhasCategorias(){
  if(souAdmin()) return Object.keys(CATEGORIAS);
  return Object.keys(CATEGORIAS).filter(k => CATEGORIAS[k].responsavelEmail === meuEmail());
}
function souGestor(){ return minhasCategorias().length > 0; }
function possoGerir(t){ return souAdmin() || minhasCategorias().includes(t.categoria); }
/* Quem vê SÓ a própria área (+ o que abriu). Todos os outros veem todos os chamados
   (mas só alteram status/comentam onde são responsáveis). */
const VISAO_RESTRITA = ["mariajulia.mendes@igreenenergy.com.br"];
function vejoTudo(){ return souAdmin() || !VISAO_RESTRITA.includes(meuEmail()); }

/* ---------------- LOGIN ---------------- */
$("loginForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  $("loginError").textContent = "";
  const email = $("loginEmail").value.trim();
  const senha = $("loginSenha").value;
  $("loginSubmit").disabled = true;
  try{
    await signInWithEmailAndPassword(auth, email, senha);
  }catch(err){
    $("loginError").textContent = traduzErro(err.code);
  }
  $("loginSubmit").disabled = false;
});

function traduzErro(code){
  const map = {
    "auth/invalid-email":"E-mail inválido.",
    "auth/user-not-found":"Usuário não encontrado.",
    "auth/wrong-password":"Senha incorreta.",
    "auth/invalid-credential":"E-mail ou senha incorretos.",
    "auth/email-already-in-use":"Este e-mail já está cadastrado.",
    "auth/weak-password":"A senha precisa ter ao menos 6 caracteres.",
    "auth/configuration-not-found":"Configuração do Firebase inválida — confira o firebaseConfig no script.js.",
    "auth/invalid-api-key":"Chave de API do Firebase inválida — confira o firebaseConfig no script.js.",
    "auth/operation-not-allowed":"Login por e-mail/senha não está ativado no Firebase (Authentication → Sign-in method).",
    "auth/unauthorized-domain":"Este domínio não está autorizado no Firebase (Authentication → Settings → Authorized domains).",
    "auth/network-request-failed":"Falha de conexão. Verifique a internet e tente novamente."
  };
  return map[code] || `Não foi possível concluir. (${code||"erro desconhecido"})`;
}

$("btnLogout").onclick = () => signOut(auth);

onAuthStateChanged(auth, async (user) => {
  if(user){
    currentUser = user;
    let snap = await getDoc(doc(db,"usuarios",user.uid));
    if(!snap.exists()){
      await setDoc(doc(db,"usuarios",user.uid), { nome: user.email, email: user.email, criadoEm: serverTimestamp() });
      snap = await getDoc(doc(db,"usuarios",user.uid));
    }
    currentUserProfile = snap.data();
    $("userLabel").textContent = currentUserProfile.nome;
    $("userAv").textContent = initials(currentUserProfile.nome);
    $("loginScreen").classList.add("hidden");
    $("mainScreen").classList.remove("hidden");
    startTicketsListener();
  } else {
    currentUser = null;
    currentUserProfile = null;
    allTickets = [];
    commentCounts = {};
    stopListeners();
    $("mainScreen").classList.add("hidden");
    $("loginScreen").classList.remove("hidden");
  }
});

/* ---------------- TABS ---------------- */
document.querySelectorAll(".tab").forEach(tab=>{
  tab.addEventListener("click", ()=>{
    document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.dataset.tab;
    $("tabNovo").classList.toggle("hidden", target!=="novo");
    $("tabChamados").classList.toggle("hidden", target!=="chamados");
    if(target === "chamados"){
      unreadCount = 0;
      updateBadges();
    }
  });
});

/* ---------------- PAINEL DE NOTIFICAÇÕES (sininho) ---------------- */
$("btnNotify").onclick = async () => {
  if("Notification" in window && Notification.permission === "default"){
    Notification.requestPermission();
  }
  $("notifPanel").classList.toggle("hidden");
  if(!$("notifPanel").classList.contains("hidden")){
    renderNotifPanel();
    unreadCount = 0;
    updateBadges();
  }
};
document.addEventListener("click", (e)=>{
  if(!$("notifPanel").contains(e.target) && e.target !== $("btnNotify") && !$("btnNotify").contains(e.target)){
    $("notifPanel").classList.add("hidden");
  }
});

function renderNotifPanel(){
  const abertos = allTickets.filter(t=>t.status === "aberto");
  const el = $("notifList");
  if(abertos.length === 0){
    el.innerHTML = `<div class="notif-empty">Nenhum chamado em aberto no momento.</div>`;
    return;
  }
  el.innerHTML = abertos.map(t=>{
    return `
    <div class="notif-item" data-notif-id="${t.id}">
      <div class="notif-name">${esc(t.nomeLicenciado)}</div>
      <div class="notif-meta">Aberto por ${esc(t.criadoPor?.nome||"—")} · ${fmtData(t.criadoEm)}</div>
    </div>`;
  }).join("");
  document.querySelectorAll("[data-notif-id]").forEach(item=>{
    item.onclick = () => {
      $("notifPanel").classList.add("hidden");
      document.querySelector('.tab[data-tab="chamados"]').click();
      document.querySelector('#filters .filter-chip[data-status="aberto"]').click();
    };
  });
}

function updateBadges(){
  const nb = $("notifBadge"), tb = $("tabBadge");
  if(unreadCount > 0){
    const txt = unreadCount > 9 ? "9+" : unreadCount;
    nb.textContent = txt; nb.classList.remove("hidden");
    tb.textContent = txt; tb.classList.remove("hidden");
  } else {
    nb.classList.add("hidden");
    tb.classList.add("hidden");
  }
}

/* ---------------- ANEXO (opcional, comprimido e guardado no Firestore) ---------------- */
const ANEXO_LIMITE_BYTES = 700000; // ~700KB de base64, com folga no limite de 1MB do documento

function comprimirImagem(file, maxDim, qualidade){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => { img.src = e.target.result; };
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if(width > height && width > maxDim){ height = Math.round(height*(maxDim/width)); width = maxDim; }
      else if(height > maxDim){ width = Math.round(width*(maxDim/height)); height = maxDim; }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", qualidade));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function prepararAnexo(file){
  const tentativas = [ [1280,0.7], [1024,0.6], [800,0.5], [640,0.4], [480,0.35] ];
  for(const [maxDim, qualidade] of tentativas){
    const dataUrl = await comprimirImagem(file, maxDim, qualidade);
    if(dataUrl.length <= ANEXO_LIMITE_BYTES) return dataUrl;
  }
  return null;
}

function limparAnexo(){
  uploadedEvidence = null;
  $("fFile").value = "";
  $("fileDrop").textContent = "Toque para selecionar uma foto";
  $("fileDrop").classList.remove("has-file");
  $("previewWrap").classList.add("hidden");
  $("previewWrap").innerHTML = "";
  $("fileClear").classList.add("hidden");
}

$("fileDrop").onclick = () => $("fFile").click();
$("fileClear").onclick = limparAnexo;
$("fFile").addEventListener("change", async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  $("fileDrop").textContent = "Processando foto…";
  try{
    const dataUrl = await prepararAnexo(file);
    if(!dataUrl){
      limparAnexo();
      $("fileDrop").textContent = "Foto muito pesada — escolha outra (ou envie sem anexo).";
      return;
    }
    uploadedEvidence = { url: dataUrl, tipo: "imagem" };
    $("fileDrop").textContent = `Anexo: ${file.name}`;
    $("fileDrop").classList.add("has-file");
    const wrap = $("previewWrap");
    wrap.classList.remove("hidden");
    wrap.innerHTML = `<img src="${dataUrl}" alt="Anexo">`;
    $("fileClear").classList.remove("hidden");
  }catch(err){
    limparAnexo();
    $("fileDrop").textContent = "Não foi possível processar a foto. Toque para tentar novamente.";
  }
});

/* ---------------- ABRIR CHAMADO ---------------- */
$("ticketForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  $("ticketError").textContent = "";
  const categoria = "chip";
  const c = CATEGORIAS[categoria];
  $("ticketSubmit").disabled = true;
  try{
    const dados = {
      categoria,
      responsavelEmail: c.responsavelEmail,
      responsavelNome: c.responsavelNome,
      idLicenciado: $("fId").value.trim(),
      nomeLicenciado: $("fNome").value.trim(),
      descricao: $("fDesc").value.trim(),
      status: "aberto",
      criadoPor: { uid: currentUser.uid, nome: currentUserProfile.nome, email: meuEmail() },
      criadoEm: serverTimestamp(),
      atualizadoEm: serverTimestamp(),
      historico: [{ status:"aberto", por: currentUserProfile.nome, em: new Date().toISOString() }]
    };
    if(uploadedEvidence){
      dados.anexoUrl = uploadedEvidence.url;
      dados.anexoTipo = uploadedEvidence.tipo;
    }
    await addDoc(collection(db,"chamados"), dados);
    $("ticketForm").reset();
    limparAnexo();
    toast("Chamado aberto", `Enviado para ${c.responsavelNome}.`, "feito");
  }catch(err){
    console.error(err);
    $("ticketError").textContent = "Não foi possível abrir o chamado. Tente novamente.";
  }
  $("ticketSubmit").disabled = false;
});

/* ---------------- LISTA / TEMPO REAL ----------------
   Quase todos escutam a coleção inteira.
   Maria Julia escuta só a área Chip + o que ela abriu. */
function stopListeners(){
  unsubscribers.forEach(u=>u());
  unsubscribers = [];
}

function startTicketsListener(){
  stopListeners();
  const col = collection(db,"chamados");
  let consultas;
  if(vejoTudo()){
    consultas = [ query(col, orderBy("criadoEm","desc")) ];
  } else {
    consultas = minhasCategorias().map(cat => query(col, where("categoria","==",cat)));
    consultas.push(query(col, where("criadoPor.uid","==",currentUser.uid)));
  }

  const resultados = consultas.map(()=>null);
  const vistos = new Set();
  let carregado = false;

  consultas.forEach((q, i)=>{
    const unsub = onSnapshot(q, (snap)=>{
      resultados[i] = snap.docs.map(d=>({ id:d.id, ...d.data() }));
      if(resultados.some(r=>r===null)) return; // espera todas as consultas chegarem

      const mapa = new Map();
      resultados.flat().forEach(t=>mapa.set(t.id, t));
      const lista = [...mapa.values()].sort((a,b)=>tsMs(b.criadoEm) - tsMs(a.criadoEm));

      if(carregado){
        lista.forEach(t=>{
          if(!vistos.has(t.id)){
            // chamado novo: avisa quem é responsável por ele
            if(possoGerir(t) && t.criadoPor?.uid !== currentUser.uid){
              unreadCount++;
              beep();
              toast("Novo chamado", `<b>${esc(t.nomeLicenciado)}</b> aberto por ${esc(t.criadoPor?.nome||"—")}`, "aberto");
              if("Notification" in window && Notification.permission === "granted"){
                new Notification("Novo chamado", { body: `${t.nomeLicenciado} — aberto por ${t.criadoPor?.nome||""}` });
              }
              updateBadges();
            }
          } else {
            // novo comentário em chamado que eu abri
            const comentarios = t.comentarios || [];
            const anterior = commentCounts[t.id] ?? comentarios.length;
            const ultimo = comentarios[comentarios.length-1];
            if(comentarios.length > anterior && t.criadoPor?.uid === currentUser.uid && ultimo && ultimo.porUid !== currentUser.uid){
              beep();
              toast("Novo comentário", `<b>${esc(ultimo.por)}</b> comentou no chamado de <b>${esc(t.nomeLicenciado)}</b>: "${esc(ultimo.texto)}"`, "analise");
              if("Notification" in window && Notification.permission === "granted"){
                new Notification("Novo comentário no seu chamado", { body: `${ultimo.por}: ${ultimo.texto}` });
              }
            }
          }
        });
      }
      lista.forEach(t=>{ vistos.add(t.id); commentCounts[t.id] = (t.comentarios||[]).length; });
      carregado = true;

      allTickets = lista;
      renderTickets();
      renderMyHistory();
      if(!$("notifPanel").classList.contains("hidden")) renderNotifPanel();
    }, (err)=>{
      console.error(err);
      toast("Erro ao carregar", "Sem permissão para ler os chamados. Confira as regras do Firestore.", "aberto");
    });
    unsubscribers.push(unsub);
  });
}

function renderTickets(){
  const porCat = allTickets;

  const counts = { todos: porCat.length, aberto:0, analise:0, feito:0 };
  porCat.forEach(t=>counts[t.status]!==undefined && counts[t.status]++);
  $("cAll").textContent = counts.todos;
  $("cAberto").textContent = counts.aberto;
  $("cAnalise").textContent = counts.analise;
  $("cFeito").textContent = counts.feito;

  const porStatus = activeFilter === "todos" ? porCat : porCat.filter(t=>t.status===activeFilter);
  const termo = searchTerm.trim().toLowerCase();
  const filtered = !termo ? porStatus : porStatus.filter(t=>
    (t.idLicenciado||"").toLowerCase().includes(termo) ||
    (t.nomeLicenciado||"").toLowerCase().includes(termo) ||
    (t.descricao||"").toLowerCase().includes(termo) ||
    (t.criadoPor?.nome||"").toLowerCase().includes(termo)
  );
  const list = $("ticketList");
  if(filtered.length === 0){
    list.innerHTML = `<div class="card empty"><div class="glyph">🗒️</div>Nenhum chamado encontrado.</div>`;
    return;
  }
  list.innerHTML = filtered.map(t=>ticketCard(t)).join("");
  attachCardHandlers(list);
}

function abrirImagem(ticketId){
  const t = allTickets.find(x=>x.id === ticketId);
  const url = t && (t.anexoUrl || t.evidenciaUrl);
  if(!url) return;
  const overlay = document.createElement("div");
  overlay.className = "lightbox-overlay";
  overlay.innerHTML = `<img src="${url}" alt="Anexo do chamado"><button type="button" class="lightbox-close" aria-label="Fechar">✕</button>`;
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

function ticketCard(t){
  const c = catInfo(t.categoria);
  const gerir = possoGerir(t);

  const hist = (t.historico||[]).slice().reverse().map(h=>
    `<div class="hist-item"><b>${STATUS_LABEL[h.status]||esc(h.status)}</b> — ${esc(h.por)} · ${fmtCurto(h.em)}</div>`
  ).join("") || `<div class="hist-item">Sem histórico.</div>`;

  const comentarios = t.comentarios || [];
  const comentariosHtml = comentarios.length
    ? comentarios.map(cm=>`
        <div class="comment-item">
          ${esc(cm.texto)}
          <div class="comment-meta">${esc(cm.por)} · ${fmtCurto(cm.em)}</div>
        </div>`).join("")
    : `<div class="comment-empty">Nenhum comentário ainda.</div>`;
  const comentarioForm = gerir
    ? `<div class="comment-form">
         <input type="text" placeholder="Escrever um comentário para quem abriu…" data-comment-input="${t.id}">
         <button type="button" data-comment-send="${t.id}">Enviar</button>
       </div>`
    : "";

  // chamados antigos (do sistema de bloqueio) não têm área
  const catTag = c ? "" : `<span class="cat-tag sem">Antigo</span>`;
  const respTag = c ? `<span class="gestor-tag">📌 ${c.responsavelNome}</span>` : "";
  const highlight = (gerir && t.status !== "feito") ? "is-highlight" : "";
  const anexo = t.anexoUrl || t.evidenciaUrl;

  return `
  <div class="card ticket ${highlight}" data-id="${t.id}">
    <div class="ticket-head">
      <div>
        <div class="ticket-id mono">ID ${esc(t.idLicenciado)}</div>
        <div class="ticket-name">${esc(t.nomeLicenciado)}</div>
      </div>
      <div class="ticket-tags">
        ${catTag}
        <span class="status-tag ${t.status}">${STATUS_LABEL[t.status]||esc(t.status)}</span>
        ${respTag}
      </div>
    </div>
    <div class="ticket-desc">${esc(t.descricao)}</div>
    <div class="ticket-meta">
      <span>Aberto por <b>${esc(t.criadoPor?.nome||"—")}</b></span>
      <span>Em <b>${fmtData(t.criadoEm)}</b></span>
    </div>
    ${anexo ? `<div class="ticket-evidence"><img src="${anexo}" alt="Anexo do chamado" data-open-img="${t.id}"></div>` : ""}
    <div class="ticket-body-pad">
      ${statusRail(t.status, gerir)}
      <button class="hist-toggle" data-toggle="${t.id}">▾ Ver histórico</button>
      <div class="hist-list" data-hist="${t.id}">${hist}</div>
      <div class="comments">
        <div class="comments-title">Comentários${comentarios.length ? ` (${comentarios.length})` : ""}</div>
        <div>${comentariosHtml}</div>
        ${comentarioForm}
      </div>
    </div>
  </div>`;
}

function statusRail(current, editavel){
  const idx = STATUS_ORDER.indexOf(current);
  return `<div class="rail">
    ${STATUS_ORDER.map((s,i)=>{
      const state = i < idx ? "done" : i === idx ? "current" : "pending";
      const conteudo = `
          <span class="rail-dot">${i+1}</span>
          <span class="rail-label">${STATUS_LABEL[s]}</span>`;
      return `
      <div class="rail-node" data-state="${state}" data-status="${s}">
        ${i>0 ? `<div class="rail-line left"></div>`:""}
        ${i<STATUS_ORDER.length-1 ? `<div class="rail-line right"></div>`:""}
        ${editavel
          ? `<button type="button" data-set-status="${s}">${conteudo}</button>`
          : `<div class="rail-node-view">${conteudo}</div>`}
      </div>`;
    }).join("")}
  </div>`;
}

function attachCardHandlers(root){
  root.querySelectorAll("[data-toggle]").forEach(btn=>{
    btn.onclick = () => {
      const el = root.querySelector(`[data-hist="${btn.dataset.toggle}"]`);
      el.classList.toggle("open");
      btn.textContent = (el.classList.contains("open") ? "▴ Ocultar histórico" : "▾ Ver histórico");
    };
  });
  root.querySelectorAll("[data-open-img]").forEach(img=>{
    img.onclick = () => abrirImagem(img.dataset.openImg);
  });
  root.querySelectorAll("[data-set-status]").forEach(btn=>{
    btn.onclick = async () => {
      const ticketId = btn.closest(".ticket").dataset.id;
      const newStatus = btn.dataset.setStatus;
      try{
        await updateDoc(doc(db,"chamados",ticketId), {
          status: newStatus,
          atualizadoEm: serverTimestamp(),
          historico: arrayUnion({ status:newStatus, por: currentUserProfile.nome, em: new Date().toISOString() })
        });
      }catch(err){
        toast("Erro", "Você não tem permissão para alterar este chamado.", "aberto");
      }
    };
  });
  root.querySelectorAll("[data-comment-send]").forEach(btn=>{
    const ticketId = btn.dataset.commentSend;
    const input = root.querySelector(`[data-comment-input="${ticketId}"]`);
    const enviar = async () => {
      const texto = input.value.trim();
      if(!texto) return;
      btn.disabled = true;
      try{
        await updateDoc(doc(db,"chamados",ticketId), {
          comentarios: arrayUnion({ texto, por: currentUserProfile.nome, porUid: currentUser.uid, em: new Date().toISOString() }),
          atualizadoEm: serverTimestamp()
        });
        input.value = "";
      }catch(err){
        toast("Erro", "Não foi possível enviar o comentário.", "aberto");
      }
      btn.disabled = false;
    };
    btn.onclick = enviar;
    input.addEventListener("keydown", (e)=>{ if(e.key === "Enter"){ e.preventDefault(); enviar(); } });
  });
}

function renderMyHistory(){
  const mine = allTickets.filter(t=>t.criadoPor?.uid === currentUser.uid).slice(0,5);
  const el = $("myHistory");
  if(mine.length===0){ el.innerHTML = `<div class="card empty" style="padding:24px"><div class="glyph">📭</div>Você ainda não abriu chamados.</div>`; return; }
  el.innerHTML = mine.map(t=>ticketCard(t)).join("");
  attachCardHandlers(el);
}

/* ---------------- BUSCA ---------------- */
$("searchInput").addEventListener("input", (e)=>{
  searchTerm = e.target.value;
  renderTickets();
});

/* ---------------- FILTROS ---------------- */
document.querySelectorAll("#filters .filter-chip").forEach(chip=>{
  chip.addEventListener("click", ()=>{
    document.querySelectorAll("#filters .filter-chip").forEach(c=>c.classList.remove("active"));
    chip.classList.add("active");
    activeFilter = chip.dataset.status;
    renderTickets();
  });
});