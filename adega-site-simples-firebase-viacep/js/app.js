
// === CONFIG DO PROJETO (Firebase) ===
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

// Firebase modular SDK (ESM via gstatic)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js";
import { getDatabase, ref, onValue, set } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-database.js";

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

// ====== DOM ======
const els = {
  list:     document.getElementById('product-list'),
  cart:     document.getElementById('cart-items'),
  subtotal: document.getElementById('subtotal'),
  shipping: document.getElementById('shipping'),
  total:    document.getElementById('grand-total'),
  modal:    document.getElementById('modal'),
  request:  document.getElementById('btn-request'),
  status:   document.getElementById('status'),
  cep:      document.getElementById('cep'),
  // Área pós-entrega (botão “Voltar às compras”)
  postActions: document.getElementById('post-actions'),
  // Aba de histórico
  ordersDone: document.getElementById('orders-done'),
};

const fmt = v => Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});

// ====== ESTADO ======
let SETTINGS = { freeShippingThreshold: 100, priceMotoboy: 15, priceCarro: 25 };
let WINES = [];
const cart = [];
let ultimoEndereco = null; // ViaCEP

// Acompanhamento de status (cliente)
let LAST_ORDER_ID = localStorage.getItem('lastOrderId') || null;
let LAST_REQ_ID   = localStorage.getItem('lastReqId')   || null;
let lastOrderObj  = null;
let lastReqObj    = null;
let timerId       = null; // contador “procurando motorista”
let deliveryPersonsMap = {}; // { driverId: {id, name, vehicle, active} }
let clearedOrderId = null;   // evitar zerar carrinho mais de uma vez

const ORDER_STATUS_LABEL = {
  solicitado: 'Solicitado',
  aceito: 'Aceito',
  a_caminho_cliente: 'A caminho do cliente',
  entregue: 'Entregue',
  cancelado: 'Cancelado',
};

// ===== ViaCEP =====
async function buscarEnderecoViaCEP(cepRaw) {
  const cep = (cepRaw || '').replace(/\D/g, '');
  if (cep.length !== 8) throw new Error('CEP deve ter 8 dígitos');
  const resp = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
  if (!resp.ok) throw new Error('Erro ao consultar CEP');
  const data = await resp.json();
  if (data.erro) throw new Error('CEP não encontrado');
  return { cep: data.cep, logradouro: data.logradouro || '', bairro: data.bairro || '', cidade: data.localidade || '', uf: data.uf || '' };
}

function mostrarCepInfo(info) {
  const el = document.getElementById('cep-info');
  if (!el) return;
  if (!info) {
    el.textContent = 'CEP inválido ou não encontrado.';
    el.style.color = '#ffd166';
    return;
  }
  const txt = [
    info.logradouro || null,
    info.bairro || null,
    (info.cidade && info.uf) ? `${info.cidade}/${info.uf}` : null,
    info.cep ? `CEP ${info.cep}` : null
  ].filter(Boolean).join(' • ');
  el.textContent = txt || 'CEP válido.';
  el.style.color = '';
}

els.cep.addEventListener('blur', async () => {
  const raw = els.cep.value;
  try {
    const info = await buscarEnderecoViaCEP(raw);
    ultimoEndereco = info;
    mostrarCepInfo(info);
  } catch (e) {
    console.warn(e.message);
    ultimoEndereco = null;
    mostrarCepInfo(null);
  }
});

// ====== Leitura em tempo real ======
onValue(ref(db, 'settings'), (snap) => {
  const s = snap.val();
  if (s) SETTINGS = s;
  renderCart();
});

onValue(ref(db, 'wines'), (snap) => {
  const data = snap.val() || {};
  WINES = Object.values(data);
  renderProducts();
});

onValue(ref(db, 'deliveryPersons'), (snap) => {
  const drivers = snap.val() || {};
  deliveryPersonsMap = drivers || {};
  const modal = els.modal.value;
  const available = Object.values(drivers).some(d => d.active && d.vehicle === modal);
  els.request.disabled = !available;
  els.request.title = available ? '' : 'Nenhum motorista disponível para o modal selecionado.';
  renderClientStatus(); // atualiza mensagens com nome do motorista
});

// Histórico geral (para aba “Pedidos realizados”)
onValue(ref(db, 'orders'), (snap) => {
  const allOrders = snap.val() || {};
  renderOrdersDone(allOrders);
});

// ====== Assinar último pedido + request ======
function subscribeLastOrderAndRequest() {
  if (timerId) { clearInterval(timerId); timerId = null; }

  if (LAST_ORDER_ID) {
    onValue(ref(db, `orders/${LAST_ORDER_ID}`), (snap) => {
      lastOrderObj = snap.val() || null;
      renderClientStatus();
    });
  }
  if (LAST_REQ_ID) {
    onValue(ref(db, `requests/${LAST_REQ_ID}`), (snap) => {
      lastReqObj = snap.val() || null;
      renderClientStatus();
    });
  }

  // atualiza contador a cada segundo enquanto “pending”
  timerId = setInterval(() => {
    if (lastReqObj && lastReqObj.status === 'pending') {
      renderClientStatus(); // recalcula mm:ss
    }
  }, 1000);
}

// ====== Render lógico para o cliente ======
function renderClientStatus() {
  // limpa ações pós-entrega
  if (els.postActions) els.postActions.innerHTML = '';

  if (!lastOrderObj) { els.status.textContent = '—'; return; }

  const orderStatus = lastOrderObj?.status || '—';
  const reqStatus   = lastReqObj?.status   || null;
  const assignedId  = lastReqObj?.assignedTo || null;
  const driverName  = assignedId && deliveryPersonsMap && deliveryPersonsMap[assignedId]
    ? deliveryPersonsMap[assignedId].name
    : null;

  // Zera carrinho uma única vez quando a entrega é confirmada
  if (orderStatus === 'entregue' && clearedOrderId !== lastOrderObj.id) {
    clearCartAfterDelivery();
    clearedOrderId = lastOrderObj.id;

    // Mostra botão “Voltar às compras”
    if (els.postActions) {
      const btnBack = document.createElement('button');
      btnBack.className = 'primary';
      btnBack.textContent = 'Voltar às compras';
      btnBack.onclick = () => {
        // opcional: rolar para a seção de produtos
        document.getElementById('product-list')?.scrollIntoView({ behavior: 'smooth' });
        // resetar status visual
        els.status.textContent = 'Faça seu novo pedido';
      };
      els.postActions.appendChild(btnBack);
    }
  }

  // Sem request ainda: mostra status do pedido
  if (!lastReqObj) {
    const label = ORDER_STATUS_LABEL[orderStatus] || orderStatus;
    els.status.textContent = `Status do pedido #${lastOrderObj.id}: ${label}`;
    return;
  }

  // Procurando motorista (pending): contador 60s
  if (reqStatus === 'pending') {
    const now      = Date.now();
    const remainMs = Math.max(0, (lastReqObj.expiresAt || now) - now);
    const mm = Math.floor(remainMs / 60000);
    const ss = Math.floor((remainMs % 60000) / 1000).toString().padStart(2, '0');
    els.status.textContent = `Procurando motorista… (tempo restante: ${mm}:${ss})`;
    if (remainMs === 0) {
      els.status.textContent = 'Não encontramos motorista em 60s. Tente novamente.';
      // botão para voltar às compras
      if (els.postActions) {
        const btnBack = document.createElement('button');
        btnBack.className = 'primary';
        btnBack.textContent = 'Voltar às compras';
        btnBack.onclick = () => document.getElementById('product-list')?.scrollIntoView({ behavior: 'smooth' });
        els.postActions.appendChild(btnBack);
      }
    }
    return;
  }

  // Motorista aceitou / indo à adega
  if (reqStatus === 'accepted' || reqStatus === 'to_adega') {
    const name = driverName ? ` ${driverName}` : '';
    els.status.textContent = `Motorista${name} aceitou. A caminho da adega.`;
    return;
  }

  // Em rota ao cliente
  if (reqStatus === 'to_customer' || orderStatus === 'a_caminho_cliente') {
    const name = driverName ? ` ${driverName}` : '';
    els.status.textContent = `Seu pedido está a caminho com o motorista${name}.`;
    return;
  }

  // Entregue
  if (orderStatus === 'entregue') {
    const name = driverName ? ` por ${driverName}` : '';
    els.status.textContent = `Pedido entregue${name}. Bom proveito!`;
    // (botão já foi adicionado acima ao zerar carrinho)
    return;
  }

  // Cancelado/Expirado
  if (orderStatus === 'cancelado' || reqStatus === 'canceled' || reqStatus === 'expired') {
    els.status.textContent = (reqStatus === 'expired')
      ? 'Solicitação expirou. Tente novamente.'
      : 'Pedido cancelado.';
    // botão para voltar às compras
    if (els.postActions) {
      const btnBack = document.createElement('button');
      btnBack.className = 'primary';
      btnBack.textContent = 'Voltar às compras';
      btnBack.onclick = () => document.getElementById('product-list')?.scrollIntoView({ behavior: 'smooth' });
      els.postActions.appendChild(btnBack);
    }
    return;
  }

  // Fallback
  const label = ORDER_STATUS_LABEL[orderStatus] || orderStatus;
  els.status.textContent = `Status do pedido #${lastOrderObj.id}: ${label}`;
}

// ====== Zeramento do carrinho ao entregar ======
function clearCartAfterDelivery(){
  cart.length = 0;
  renderCart();
  const banner = document.createElement('div');
  banner.className = 'status ok';
  banner.textContent = 'Carrinho zerado após entrega.';
  els.cart.parentElement.insertBefore(banner, els.cart);
  setTimeout(() => banner.remove(), 4000);
}

// ====== UI de produtos/carrinho ======
function renderProducts(){
  els.list.innerHTML = '';
  if (WINES.length === 0) {
    els.list.innerHTML = '<p class="status">Nenhum vinho cadastrado.</p>';
    return;
  }
  WINES.forEach(w => {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `<h3>${w.name}</h3><p>${w.desc || ''}</p><p><strong>${fmt(w.price)}</strong></p>`;
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Adicionar';
    btn.onclick = () => { addToCart(w); };
    div.appendChild(btn);
    els.list.appendChild(div);
  });
}

function addToCart(w){
  const i = cart.findIndex(x => x.id === w.id);
  const price = Number(w.price);
  if(i>=0) cart[i].qty += 1; else cart.push({id:w.id,name:w.name,price,qty:1});
  renderCart();
}

function renderCart(){
  els.cart.innerHTML = '';
  cart.forEach(it => {
    const row = document.createElement('div');
    row.className = 'cart-item';
    row.innerHTML = `<span>${it.name} x${it.qty}</span><span>${fmt(it.price*it.qty)}</span>`;
    els.cart.appendChild(row);
  });
  const subtotal = cart.reduce((acc,it)=>acc+it.price*it.qty,0);
  els.subtotal.textContent = fmt(subtotal);
  const modal = els.modal.value;
  let shipVal = 0, shipTxt = '—';
  if(subtotal>0){
    if(subtotal>=Number(SETTINGS.freeShippingThreshold)){ shipTxt='Grátis'; shipVal=0; }
    else { shipVal = modal==='motoboy'?Number(SETTINGS.priceMotoboy):Number(SETTINGS.priceCarro); shipTxt = fmt(shipVal); }
  }
  els.shipping.textContent = shipTxt;
  els.total.textContent    = fmt(subtotal+shipVal);
}

els.modal.addEventListener('change', renderCart);

// ====== Aba “Pedidos realizados” (por CEP) ======
function renderOrdersDone(allOrdersObj){
  if (!els.ordersDone) return; // precisa da div no HTML
  els.ordersDone.innerHTML = '';

  // usa CEP informado/validado
  const cepFiltro = (ultimoEndereco?.cep || els.cep.value || '').replace(/\D/g, '');
  const list = Object.values(allOrdersObj || {})
    .filter(o => {
      const ocep = (o.address?.cep || o.cep || '').replace(/\D/g, '');
      return cepFiltro && ocep === cepFiltro;
    })
    .sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 20);

  if (cepFiltro === '') {
    els.ordersDone.innerHTML = '<p class="status">Digite seu CEP para ver pedidos realizados.</p>';
    return;
  }
  if (list.length === 0){
    els.ordersDone.innerHTML = '<p class="status">Nenhum pedido encontrado para este CEP.</p>';
    return;
  }
  list.forEach(o => {
    const div = document.createElement('div');
    div.className = 'card';
    const stLabel = ORDER_STATUS_LABEL[o.status] || o.status;
    const when    = o.createdAt ? new Date(o.createdAt).toLocaleString('pt-BR') : '—';
    div.innerHTML = `
      <h3>Pedido #${o.id}</h3>
      <p>Status: ${stLabel}</p>
      <p>Total: ${fmt(o.total)}</p>
      <p>Data: ${when}</p>
    `;
    els.ordersDone.appendChild(div);
  });
}

// ====== Gravação de pedido ======
els.request.addEventListener('click', async () => {
  const subtotal = cart.reduce((acc,it)=>acc+it.price*it.qty,0);
  if(subtotal===0){ alert('Adicione vinhos ao carrinho.'); return; }

  const modal = els.modal.value;
  const shipping = (subtotal>=Number(SETTINGS.freeShippingThreshold))
    ? 0
    : (modal==='motoboy' ? Number(SETTINGS.priceMotoboy) : Number(SETTINGS.priceCarro));

  const orderId = 'ord_'+Date.now();
  const reqId   = 'req_'+Date.now();
  const nowMs   = Date.now();

  const order = {
    id: orderId,
    items: cart,
    cep: els.cep.value || '95670-000',
    modal,
    subtotal,
    shipping,
    total: subtotal + shipping,
    status: 'solicitado',
    createdAt: new Date().toISOString(),
    address: {
      logradouro: ultimoEndereco?.logradouro || '',
      bairro:     ultimoEndereco?.bairro     || '',
      cidade:     ultimoEndereco?.cidade     || '',
      uf:         ultimoEndereco?.uf         || '',
      cep:        ultimoEndereco?.cep        || (els.cep.value || '')
    }
  };

  try {
    // Grava pedido
    await set(ref(db, `orders/${orderId}`), order);

    // Grava solicitação (request) com 60 segundos para aceitar
    await set(ref(db, `requests/${reqId}`), {
      id: reqId,
      orderId,
      modal,
      status: 'pending',
      createdAt: nowMs,
      expiresAt: nowMs + 60 * 1000, // 60s
      assignedTo: null
    });

    // Salva ids e assina em tempo real
    LAST_ORDER_ID = orderId;
    LAST_REQ_ID   = reqId;
    localStorage.setItem('lastOrderId', LAST_ORDER_ID);
    localStorage.setItem('lastReqId',   LAST_REQ_ID);

    els.status.textContent = 'Pedido enviado para o Firebase com sucesso.';
    subscribeLastOrderAndRequest();

  } catch (e) {
    console.error(e);
    els.status.textContent = 'Falha ao enviar pedido ao Firebase.';
  }
});

// Inicialização
renderCart();
subscribeLastOrderAndRequest();
