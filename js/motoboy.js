
// === CONFIG DO SEU PROJETO (igual ao index) ===
const firebaseConfig = {
  apiKey: "AIzaSyBl9_jHfXyBpRikL2zwOiMhDbU-8-Zg7KY",
  authDomain: "adegadommedeiros-c9492.firebaseapp.com",
  databaseURL: "https://adegadommedeiros-c9492-default-rtdb.firebaseio.com",
  projectId: "adegadommedeiros-c9492",
  storageBucket: "adegadommedeiros-c9492.firebasestorage.app",
  messagingSenderId: "1064802301412",
  appId: "1:1064802301412:web:ddf9ae75f0cbc19aa143f1",
  measurementId: "G-YP5YJFV2H8"
};

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js";
import {
  getDatabase, ref, onValue, update, get, runTransaction
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-database.js";

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

// ====== DOM ======
const driverSelectEl  = document.getElementById('driver');
const toggleActiveBtn = document.getElementById('toggle-active');
const activeStatusEl  = document.getElementById('active-status');
const requestListEl   = document.getElementById('request-list');
const flowPanelEl     = document.getElementById('flow-panel');

// ====== Estado ======
let currentDriverId = null;
let driversCache = {};
let lastReqsObj = {};
let lastOrdersObj = {};
let selectedReqId = null;

// ====== Assinaturas ======
onValue(ref(db, 'deliveryPersons'), (snap) => {
  driversCache = snap.val() || {};
  renderDrivers();
  renderActiveStatus();
  renderRequests(lastReqsObj);
  renderFlow(selectedReqId);
});

// Ler pedidos para mostrar detalhes no fluxo
onValue(ref(db, 'orders'), (snap) => {
  lastOrdersObj = snap.val() || {};
  renderRequests(lastReqsObj);
  renderFlow(selectedReqId);
});

// Lista solicitações por modal do motorista
onValue(ref(db, 'requests'), (snap) => {
  lastReqsObj = snap.val() || {};
  renderRequests(lastReqsObj);
  renderFlow(selectedReqId);
});

// Atualiza contador a cada segundo (expiração)
setInterval(() => { renderRequests(lastReqsObj); }, 1000);

// ====== Render motoristas ======
function renderDrivers(){
  driverSelectEl.innerHTML = '';
  const optEmpty = document.createElement('option');
  optEmpty.value = ''; optEmpty.textContent = 'Selecione seu perfil';
  driverSelectEl.appendChild(optEmpty);

  const ids = Object.keys(driversCache);
  ids.forEach(id => {
    const d = driversCache[id];
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = `${d.name} (${d.vehicle})`;
    driverSelectEl.appendChild(opt);
  });

  if (!currentDriverId && ids.length) currentDriverId = ids[0];
  if (currentDriverId) driverSelectEl.value = currentDriverId;
}

function renderActiveStatus(){
  if (!currentDriverId) { activeStatusEl.textContent = 'Nenhum motorista selecionado'; return; }
  const d = driversCache[currentDriverId];
  const ativo = d && d.active;
  activeStatusEl.textContent = ativo ? 'Status: ATIVO' : 'Status: DESATIVADO';
  activeStatusEl.className = ativo ? 'status ok' : 'status warn';
}

// ====== Eventos UI ======
driverSelectEl.addEventListener('change', () => {
  currentDriverId = driverSelectEl.value || null;
  renderActiveStatus();
  renderRequests(lastReqsObj);
  renderFlow(selectedReqId);
});

toggleActiveBtn.addEventListener('click', async () => {
  if (!currentDriverId) return;
  const d = driversCache[currentDriverId];
  const next = !d?.active;
  try {
    await update(ref(db, `deliveryPersons/${currentDriverId}`), { active: next });
  } catch (e) { console.error('Falha ao atualizar active:', e); }
});

// ====== Render solicitações ======
function renderRequests(reqsObj){
  requestListEl.innerHTML = '';
  if (!currentDriverId) return;
  const myVehicle = driversCache[currentDriverId]?.vehicle;
  const now = Date.now();

  const reqs = Object.values(reqsObj || {})
    .filter(r => r.modal === myVehicle)
    .sort((a,b)=> b.createdAt - a.createdAt);

  if (reqs.length === 0){
    requestListEl.innerHTML = '<p class="status">Nenhuma solicitação para seu modal.</p>';
    return;
  }

  reqs.forEach(r => {
    const expired = now > r.expiresAt && r.status === 'pending';
    const remain  = Math.max(0, Math.floor((r.expiresAt - now)/1000));
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      <h3>Pedido ${r.orderId}</h3>
      <p>Status: ${expired ? 'expired' : r.status}</p>
      <p class="status">Tempo restante: ${remain}s</p>
    `;

    const actions = document.createElement('div');
    actions.style.marginTop = '8px';

    // Botão Aceitar (concorrência segura)
    if (!expired && r.status === 'pending') {
      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'primary';
      acceptBtn.textContent = 'Aceitar';
      acceptBtn.onclick = () => acceptRequest(r.id);
      actions.appendChild(acceptBtn);
    }

    // Botão Gerir (se já aceitei ou em andamento)
    const iAmAssigned = r.assignedTo === currentDriverId;
    if (iAmAssigned && ['accepted','to_adega','to_customer','completed'].includes(r.status)) {
      const manageBtn = document.createElement('button');
      manageBtn.className = 'secondary';
      manageBtn.style.marginLeft = '8px';
      manageBtn.textContent = 'Gerir fluxo';
      manageBtn.onclick = () => { selectedReqId = r.id; renderFlow(selectedReqId); };
      actions.appendChild(manageBtn);
    }

    el.appendChild(actions);
    requestListEl.appendChild(el);
  });
}

// ====== Aceitar solicitação (concorrência segura) ======
async function acceptRequest(reqId){
  if (!currentDriverId) return;
  const me = driversCache[currentDriverId];
  if (!me?.active) {
    const ok = confirm('Você está DESATIVADO. Deseja ativar e aceitar?');
    if (!ok) return;
    await update(ref(db, `deliveryPersons/${currentDriverId}`), { active: true });
  }

  try {
    // 1) Transaction na request: só aceitar se status === 'pending', assignedTo vazio e não expirado
    const reqRef = ref(db, `requests/${reqId}`);
    const txReq = await runTransaction(reqRef, (curr) => {
      if (!curr) return curr;
      const now = Date.now();
      if (now > curr.expiresAt && curr.status === 'pending') {
        return { ...curr, status: 'expired' };
      }
      if (curr.status !== 'pending' || curr.assignedTo) return curr;
      // check modal do motorista
      if (curr.modal !== me.vehicle) return curr;
      return { ...curr, status: 'accepted', assignedTo: currentDriverId };
    });

    if (!txReq.committed) {
      alert('Esta solicitação já foi aceita/alterada por outro motorista.');
      return;
    }
    const r = txReq.snapshot.val();
    if (r.status !== 'accepted' || r.assignedTo !== currentDriverId) {
      alert('Não foi possível aceitar (talvez modalidade diferente ou disputa).');
      return;
    }

    // 2) Transaction no pedido: só mudar 'solicitado' -> 'aceito'
    const statusRef = ref(db, `orders/${r.orderId}/status`);
    const txOrder = await runTransaction(statusRef, (curr) => {
      if (curr !== 'solicitado') return curr;
      return 'aceito';
    });

    if (!txOrder.committed || txOrder.snapshot.val() !== 'aceito') {
      alert('O pedido já não está disponível para aceitação.');
      return;
    }

    selectedReqId = reqId;
    renderFlow(selectedReqId);
  } catch (e) {
    console.error('Falha ao aceitar:', e);
    alert('Erro ao aceitar. Tente novamente.');
  }
}

// ====== Painel de fluxo ======
async function renderFlow(reqId){
  flowPanelEl.innerHTML = '';
  if (!reqId) {
    flowPanelEl.innerHTML = '<p class="status">Nenhuma entrega selecionada.</p>';
    return;
  }
  const s = await get(ref(db, `requests/${reqId}`));
  const req = s.val();
  if (!req) {
    flowPanelEl.innerHTML = '<p class="status warn">Solicitação não encontrada.</p>';
    return;
  }
  const order = lastOrdersObj[req.orderId];

  const panel = document.createElement('div');
  panel.className = 'card';
  const h = document.createElement('h3'); h.textContent = `Fluxo do pedido ${req.orderId}`; panel.appendChild(h);

  panel.appendChild(pRow(`Request: ${req.status}`));
  if (order) {
    panel.appendChild(pRow(`Pedido: ${order.status}`));
    panel.appendChild(pRow(`Endereço: ${order.address?.logradouro || '—'}, ${order.address?.bairro || '—'} — ${order.address?.cidade || '—'} (${order.address?.uf || '—'})`));
    panel.appendChild(pRow(`Total: R$ ${Number(order.total || 0).toFixed(2)}`));
  }

  const actions = document.createElement('div');
  actions.style.marginTop = '8px';

  // Botões com validação de estado
  const canToAdega     = req.assignedTo === currentDriverId && req.status === 'accepted';
  const canToCustomer  = req.assignedTo === currentDriverId && (req.status === 'to_adega' || req.status === 'accepted');
  const canStartRoute  = canToCustomer && ['aceito','a_caminho_cliente'].includes(order?.status);
  const canDelivered   = req.assignedTo === currentDriverId && order?.status === 'a_caminho_cliente';

  const toAdegaBtn = mkBtn('Indicar: a caminho da adega', 'primary', async () => {
    try {
      if (!canToAdega) return;
      await update(ref(db, `requests/${reqId}`), { status: 'to_adega', pickedUpAt: Date.now() });
      renderFlow(reqId);
    } catch (e) { console.error(e); }
  }, !canToAdega);

  const toCustBtn = mkBtn('Indicar: a caminho do cliente', 'primary', async () => {
    try {
      if (!canToCustomer) return;
      await update(ref(db, `requests/${reqId}`), { status: 'to_customer', onRouteAt: Date.now() });
      if (order?.status === 'aceito') {
        await update(ref(db, `orders/${req.orderId}`), { status: 'a_caminho_cliente' });
      }
      renderFlow(reqId);
    } catch (e) { console.error(e); }
  }, !canToCustomer);

  const deliveredBtn = mkBtn('Confirmar entrega', 'primary', async () => {
    try {
      if (!canDelivered) return;
      await update(ref(db, `orders/${req.orderId}`), { status: 'entregue' });
      await update(ref(db, `requests/${reqId}`), { status: 'completed', deliveredAt: Date.now() });
      renderFlow(reqId);
    } catch (e) { console.error(e); }
  }, !canDelivered);

  const cancelBtn = mkBtn('Cancelar entrega', 'danger', async () => {
    const ok = confirm('Tem certeza que deseja cancelar?');
    if (!ok) return;
    try {
      await update(ref(db, `orders/${req.orderId}`), { status: 'cancelado' });
      await update(ref(db, `requests/${reqId}`), { status: 'canceled', canceledAt: Date.now() });
      renderFlow(reqId);
    } catch (e) { console.error(e); }
  }, order?.status === 'entregue' || req.status === 'completed');

  actions.appendChild(toAdegaBtn);
  actions.appendChild(toCustBtn);
  actions.appendChild(deliveredBtn);
  actions.appendChild(cancelBtn);
  panel.appendChild(actions);

  flowPanelEl.appendChild(panel);
}

// Helpers UI
function pRow(text){ const p = document.createElement('p'); p.textContent = text; return p; }
function mkBtn(label, cls, handler, disabled=false){
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  b.disabled = !!disabled;
  b.onclick = handler;
  b.style.marginRight = '8px';
  return b;
}
