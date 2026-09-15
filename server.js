// Checkout proprio - Teclado de Verdade
// Node 18+ (usa fetch nativo). Sem dependencias externas.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PAGARME_KEY = process.env.PAGARME_SECRET_KEY;      // sk_...
const N8N_WEBHOOK = process.env.N8N_WEBHOOK_URL || '';   // para onde repassar a venda paga
const WEBHOOK_USER = process.env.WEBHOOK_USER || '';     // basic auth que a Pagar.me vai enviar
const WEBHOOK_PASS = process.env.WEBHOOK_PASS || '';
const PIX_EXIGE_CPF = process.env.PIX_EXIGE_CPF === 'true'; // ligar so se o teste provar necessario
const PIX_EXPIRA_SEG = parseInt(process.env.PIX_EXPIRA_SEG || '3600', 10);
const MAX_PARCELAS = parseInt(process.env.MAX_PARCELAS || '12', 10);       // ate quantas vezes no cartao
const JUROS_MES = parseFloat(process.env.JUROS_MES || '0.0349');           // 3,49% a.m., mesmo padrao da Hotmart
const CONFERE_MIN = parseInt(process.env.CONFERE_MIN || '5', 10);          // de quantos em quantos minutos conferir pendentes
const JANELA_HORAS = parseInt(process.env.JANELA_HORAS || '48', 10);       // quanto tempo para tras conferir
const CADEMI_URL = process.env.CADEMI_POSTBACK_URL || '';                  // https://<conta>.cademi.com.br/api/postback/custom
const CADEMI_TOKEN = process.env.CADEMI_TOKEN || '';
const TDV_METADATA = process.env.TDV_METADATA !== 'false';                 // carimbo de rastreamento no metadata do pedido
// ---- Meta Conversions API (perna de servidor do rastreamento) ----
const META_PIXEL_ID   = process.env.META_PIXEL_ID   || '';     // 1295175047898011
const META_CAPI_TOKEN = process.env.META_CAPI_TOKEN || '';     // token do Gerenciador de Eventos
const META_TEST_CODE  = process.env.META_TEST_EVENT_CODE || '';// so durante o teste, apagar depois
const META_API_VER    = process.env.META_API_VERSION || 'v21.0';
const CHECKOUT_URL    = process.env.CHECKOUT_URL || 'https://pay.dozeroaoculto.com.br/';
// ---- limite de tentativas na criacao de pedido ----
// Folgado de proposito: no Brasil varios compradores saem pelo mesmo IP (CGNAT das
// operadoras de celular). Limite apertado bloquearia cliente de verdade.
// RATE_MAX=0 desliga a protecao sem precisar mexer no codigo.
const RATE_MAX = parseInt(process.env.RATE_MAX || '10', 10);
const RATE_JANELA_MIN = parseInt(process.env.RATE_JANELA_MIN || '10', 10);                       // Configuracoes > Integracoes > Chave de API

if (!PAGARME_KEY) { console.error('FALTA a variavel PAGARME_SECRET_KEY'); process.exit(1); }

const PRODUTOS = JSON.parse(fs.readFileSync(path.join(__dirname, 'produtos.json'), 'utf8'));
const API = 'https://api.pagar.me/core/v5';

// de qual entrega da Cademi cada produto faz parte
const CADEMI_IDS = (() => {
  const m = {};
  if (PRODUTOS.principal.cademi_id) m[PRODUTOS.principal.id] = String(PRODUTOS.principal.cademi_id);
  for (const b of PRODUTOS.bumps || []) if (b.cademi_id) m[b.id] = String(b.cademi_id);
  return m;
})();
const auth = 'Basic ' + Buffer.from(PAGARME_KEY + ':').toString('base64');

// ---------- persistencia simples em arquivo (o registro de verdade fica no n8n) ----------
const DB = path.join(process.env.DATA_DIR || __dirname, 'pedidos.json');
function lerDb() { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return {}; } }
function gravar(id, dados) {
  const db = lerDb();
  db[id] = { ...(db[id] || {}), ...dados, atualizado_em: new Date().toISOString() };
  try { fs.writeFileSync(DB, JSON.stringify(db, null, 2)); } catch (e) { console.error('db', e.message); }
}

// ---------- helpers ----------
const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const centavos = (v) => Math.round(Number(v) * 100);

// IP REAL do comprador. A chamada para a Pagar.me sai do servidor, entao o IP que
// ela registra e o do VPS. Este aqui e o do navegador, e e o que serve para o CAPI.
function ipDoCliente(req) {
  const h = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || '';
  if (h) return String(h).split(',')[0].trim().slice(0, 45);
  return String((req.socket && req.socket.remoteAddress) || '').slice(0, 45);
}

function validarCpf(cpf) {
  cpf = soDigitos(cpf);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (let t = 9; t < 11; t++) {
    let s = 0;
    for (let i = 0; i < t; i++) s += parseInt(cpf[i]) * (t + 1 - i);
    let d = ((s * 10) % 11) % 10;
    if (d !== parseInt(cpf[t])) return false;
  }
  return true;
}

// tabela price: valor de cada parcela com juros repassados ao comprador
function valorParcela(totalCentavos, n) {
  if (n <= 1 || JUROS_MES <= 0) return Math.round(totalCentavos);
  const i = JUROS_MES;
  const p = totalCentavos * i / (1 - Math.pow(1 + i, -n));
  return Math.round(p);
}

function montarItens(bumpsMarcados) {
  const itens = [{
    amount: centavos(PRODUTOS.principal.preco),
    description: PRODUTOS.principal.nome_completo.slice(0, 255),
    quantity: 1,
    code: PRODUTOS.principal.id
  }];
  for (const b of PRODUTOS.bumps) {
    if (bumpsMarcados.includes(b.id)) {
      itens.push({ amount: centavos(b.preco), description: b.nome.slice(0, 255), quantity: 1, code: b.id });
    }
  }
  return itens;
}

function montarCliente(d, comEndereco) {
  const tel = soDigitos(d.celular);
  const cliente = {
    name: String(d.nome || '').trim().slice(0, 64),
    email: String(d.email || '').trim().toLowerCase(),
    type: 'individual',
    phones: {
      mobile_phone: {
        country_code: '55',
        area_code: tel.slice(0, 2),
        number: tel.slice(2)
      }
    }
  };
  if (d.cpf) cliente.document = soDigitos(d.cpf);
  if (comEndereco) {
    cliente.address = {
      line_1: `${d.numero}, ${d.rua}, ${d.bairro}`.slice(0, 256),
      zip_code: soDigitos(d.cep),
      city: d.cidade,
      state: d.uf,
      country: 'BR'
    };
  }
  return cliente;
}

const tentativasPorIp = new Map();
function passouDoLimite(ip) {
  if (!ip || RATE_MAX <= 0) return false;
  const agora = Date.now();
  const janela = RATE_JANELA_MIN * 60000;
  const lista = (tentativasPorIp.get(ip) || []).filter((t) => agora - t < janela);
  lista.push(agora);
  tentativasPorIp.set(ip, lista);
  // faxina para o mapa nao crescer para sempre
  if (tentativasPorIp.size > 5000) {
    for (const [k, v] of tentativasPorIp) {
      if (!v.length || agora - v[v.length - 1] > janela) tentativasPorIp.delete(k);
    }
  }
  return lista.length > RATE_MAX;
}

async function pagarme(rota, metodo, corpo) {
  const r = await fetch(API + rota, {
    method: metodo,
    headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const texto = await r.text();
  let json; try { json = JSON.parse(texto); } catch { json = { raw: texto }; }
  return { ok: r.ok, status: r.status, json };
}

// ---------- rotas ----------
async function criarPedido(dados, ipCliente) {
  const bumps = Array.isArray(dados.bumps) ? dados.bumps : [];
  const metodo = dados.metodo === 'cartao' ? 'cartao' : 'pix';

  // validacao de entrada
  const erros = [];
  if (!dados.nome || dados.nome.trim().split(/\s+/).length < 2) erros.push('Digite seu nome completo.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dados.email || '')) erros.push('Digite um e-mail valido.');
  if (soDigitos(dados.celular).length < 10) erros.push('Digite um celular valido com DDD.');
  if (metodo === 'cartao' || PIX_EXIGE_CPF) {
    if (!validarCpf(dados.cpf)) erros.push('Digite um CPF valido.');
  }
  let parcelas = parseInt(dados.parcelas || '1', 10);
  if (!(parcelas >= 1 && parcelas <= MAX_PARCELAS)) parcelas = 1;
  if (metodo === 'cartao') {
    if (soDigitos(dados.cep).length !== 8) erros.push('Digite um CEP valido.');
    if (!dados.numero) erros.push('Digite o numero do endereco.');
    if (soDigitos(dados.cartao_numero).length < 13) erros.push('Numero do cartao invalido.');
    if (!/^\d{2}$/.test(dados.cartao_mes || '')) erros.push('Mes de validade invalido.');
    if (!/^\d{2,4}$/.test(dados.cartao_ano || '')) erros.push('Ano de validade invalido.');
    if (!/^\d{3,4}$/.test(soDigitos(dados.cartao_cvv))) erros.push('CVV invalido.');
    if (!dados.cartao_titular) erros.push('Digite o nome impresso no cartao.');
  }
  if (erros.length) return { erro: erros[0], status: 422 };

  const itens = montarItens(bumps);
  const baseCentavos = itens.reduce((s, i) => s + i.amount, 0);
  if (metodo === 'cartao' && parcelas > 1) {
    const totalComJuros = valorParcela(baseCentavos, parcelas) * parcelas;
    const juros = totalComJuros - baseCentavos;
    if (juros > 0) itens.push({ amount: juros, description: 'Acrescimo de parcelamento', quantity: 1, code: 'juros' });
  }

  const pedido = {
    items: itens,
    customer: montarCliente(dados, metodo === 'cartao'),
    metadata: {
      origem: 'checkout-proprio',
      bumps: bumps.join(',') || 'nenhum',
      parcelas: String(metodo === 'cartao' ? parcelas : 1),
      cupom: dados.cupom || '',
      utm_source: dados.utm_source || '',
      utm_campaign: dados.utm_campaign || '',
      utm_content: dados.utm_content || '',
      src: dados.src || ''
    }
  };

  // Carimbo de rastreamento. Chave NOVA, nao encosta nas quatro UTMs acima.
  // Vai numa string unica para nao esbarrar em limite de quantidade de chaves.
  // Se a Pagar.me recusar o pedido por causa disso, basta por TDV_METADATA=false
  // nas variaveis do EasyPanel e reiniciar: o checkout volta ao comportamento antigo.
  if (TDV_METADATA) {
    try {
      const carimbo = {
        id: String(dados.tdv_id || '').slice(0, 40),
        fbp: String(dados.tdv_fbp || '').slice(0, 60),
        fbc: String(dados.tdv_fbc || '').slice(0, 120),
        ua: String(dados.tdv_ua || '').slice(0, 160),
        url: String(dados.tdv_url || '').slice(0, 200),
        ip: String(ipCliente || '')
      };
      pedido.metadata.tdv = Buffer.from(JSON.stringify(carimbo), 'utf8').toString('base64');
    } catch (e) { console.error('carimbo tdv:', e.message); }
  }

  if (metodo === 'pix') {
    pedido.payments = [{ payment_method: 'pix', pix: { expires_in: PIX_EXPIRA_SEG } }];
  } else {
    pedido.payments = [{
      payment_method: 'credit_card',
      credit_card: {
        installments: parcelas,
        statement_descriptor: 'TECLADODEV',
        card: {
          number: soDigitos(dados.cartao_numero),
          holder_name: String(dados.cartao_titular).trim(),
          exp_month: parseInt(dados.cartao_mes, 10),
          exp_year: parseInt(String(dados.cartao_ano).slice(-2), 10),
          cvv: soDigitos(dados.cartao_cvv),
          billing_address: {
            line_1: `${dados.numero}, ${dados.rua}, ${dados.bairro}`.slice(0, 256),
            zip_code: soDigitos(dados.cep),
            city: dados.cidade,
            state: dados.uf,
            country: 'BR'
          }
        }
      }
    }];
  }

  const r = await pagarme('/orders', 'POST', pedido);
  if (!r.ok) {
    console.error('Pagar.me recusou:', r.status, JSON.stringify(r.json).slice(0, 800));
    const msg = r.json?.message || 'Nao consegui gerar a cobranca. Confira os dados e tente de novo.';
    return { erro: msg, status: 400, detalhe: r.json?.errors || null };
  }

  const o = r.json;
  const charge = (o.charges || [])[0] || {};
  const tx = charge.last_transaction || {};
  const total = pedido.items.reduce((s, i) => s + i.amount, 0);

  // rede de protecao: a Pagar.me aceita o pedido (201) mas a cobranca pode falhar.
  // sem isso o comprador via uma tela de Pix em branco e desistia.
  if (metodo === 'pix' && (charge.status === 'failed' || !tx.qr_code)) {
    console.error('PIX SEM QR', o.id, 'charge:', charge.status, 'motivo:', tx.acquirer_message || tx.gateway_response?.errors || 'nao informado');
    return { erro: 'Nao consegui gerar o Pix agora. Confira o CPF e tente de novo.', status: 400 };
  }
  if (metodo === 'cartao' && charge.status === 'failed') {
    console.error('CARTAO RECUSADO', o.id, tx.acquirer_message || '');
    return { erro: tx.acquirer_message || 'Pagamento nao aprovado pelo banco. Tente outro cartao ou pague com Pix.', status: 400 };
  }

  gravar(o.id, {
    order_id: o.id, status: o.status, metodo, parcelas: metodo === 'cartao' ? parcelas : 1, total_centavos: total,
    email: pedido.customer.email, nome: pedido.customer.name,
    bumps, criado_em: new Date().toISOString()
  });

  return {
    order_id: o.id,
    status: o.status,
    charge_status: charge.status,
    metodo,
    total: total / 100,
    qr_code: tx.qr_code || null,
    qr_code_url: tx.qr_code_url || null,
    expira_em: tx.expires_at || null,
    pago: charge.status === 'paid'
  };
}

async function consultarPedido(orderId) {
  const r = await pagarme('/orders/' + encodeURIComponent(orderId), 'GET');
  if (!r.ok) return { erro: 'Pedido nao encontrado', status: 404 };
  const charge = (r.json.charges || [])[0] || {};
  if (charge.status === 'paid') gravar(r.json.id, { status: 'paid', pago_em: new Date().toISOString() });
  return { order_id: r.json.id, status: r.json.status, charge_status: charge.status, pago: charge.status === 'paid' };
}

// repassa a venda paga para o n8n, com ate 3 tentativas
async function repassarN8n(evento) {
  if (!N8N_WEBHOOK) { console.log('N8N_WEBHOOK vazio, nada a repassar'); return false; }
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const r = await fetch(N8N_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(evento)
      });
      if (r.ok) return true;
      console.error('n8n respondeu', r.status, 'tentativa', tentativa);
    } catch (e) { console.error('falha ao repassar pro n8n (tentativa ' + tentativa + '):', e.message); }
    await new Promise((ok) => setTimeout(ok, tentativa * 3000));
  }
  return false;
}

// ---------- Meta Conversions API ----------
// Perna de SERVIDOR do Purchase. A perna de navegador sai do index.html com o MESMO
// event_id (o order_id), entao o Meta deduplica e conta UMA venda so.
// Falha aqui NUNCA bloqueia a entrega na Cademi.

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const hashNorm = (v) => { const t = String(v || '').trim().toLowerCase(); return t ? sha256(t) : null; };
const hashDigitos = (v) => { const t = soDigitos(v); return t ? sha256(t) : null; };

function montarPurchase(evento) {
  const t = evento.tdv || {};

  // juros NAO e receita de produto: fora do valor e fora dos content_ids
  const itens = (evento.itens || []).filter((i) => i.code && i.code !== 'juros');
  const valor = Math.round(itens.reduce((sm, i) => sm + Number(i.valor || 0), 0) * 100) / 100;

  const partes = String(evento.nome || '').trim().split(/\s+/);
  const fn = partes[0] || '';
  const ln = partes.length > 1 ? partes[partes.length - 1] : '';

  const user_data = {
    em: hashNorm(evento.email),
    ph: hashDigitos(evento.telefone),
    fn: hashNorm(fn),
    ln: hashNorm(ln),
    external_id: t.id ? sha256(t.id) : null
  };
  // estes vao em texto puro, o Meta nao aceita hash neles
  if (t.fbp) user_data.fbp = t.fbp;
  if (t.fbc) user_data.fbc = t.fbc;
  if (t.ip)  user_data.client_ip_address = t.ip;
  if (t.ua)  user_data.client_user_agent = t.ua;
  for (const k of Object.keys(user_data)) if (!user_data[k]) delete user_data[k];

  return {
    event_name: 'Purchase',
    // O Meta RECUSA evento com data no futuro. Se o paid_at vier sem fuso e for
    // lido com deslocamento, o Purchase inteiro seria descartado em silencio.
    // Por isso o valor e limitado ao instante atual e a janela de 7 dias.
    event_time: (function () {
      const agora = Math.floor(Date.now() / 1000);
      const lido = Math.floor(Date.parse(evento.pago_em || '') / 1000);
      if (isNaN(lido)) return agora;
      if (lido > agora) return agora;                       // nunca no futuro
      if (agora - lido > 6 * 24 * 3600) return agora - 6 * 24 * 3600; // nunca fora da janela
      return lido;
    })(),
    event_id: evento.order_id,
    action_source: 'website',
    // url vazia ja rendeu restricao de pixel uma vez. Nunca deixar vazio.
    event_source_url: t.url || CHECKOUT_URL,
    user_data,
    custom_data: {
      currency: 'BRL',
      value: valor,
      order_id: evento.order_id,
      content_type: 'product',
      num_items: itens.length,
      content_ids: itens.map((i) => i.code),
      contents: itens.map((i) => ({ id: i.code, quantity: 1, item_price: i.valor }))
    }
  };
}

async function enviarCapi(evento) {
  if (!META_PIXEL_ID || !META_CAPI_TOKEN) { console.log('CAPI nao configurado, pulando'); return false; }
  const corpo = { data: [montarPurchase(evento)] };
  if (META_TEST_CODE) corpo.test_event_code = META_TEST_CODE;
  const url = 'https://graph.facebook.com/' + META_API_VER + '/' + META_PIXEL_ID +
              '/events?access_token=' + encodeURIComponent(META_CAPI_TOKEN);
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo)
      });
      const txt = await r.text().catch(() => '');
      if (r.ok) { console.log('CAPI ok', evento.order_id, txt.slice(0, 200)); return true; }
      console.error('CAPI recusou', r.status, txt.slice(0, 400), 'tentativa', tentativa);
    } catch (e) { console.error('CAPI falhou (tentativa ' + tentativa + '):', e.message); }
    await new Promise((ok) => setTimeout(ok, tentativa * 3000));
  }
  return false;
}

// ---------- Cademi: libera o acesso do aluno ----------
// um POST por produto comprado. O codigo e unico por produto dentro da venda,
// e reenviar o mesmo codigo apenas atualiza a mesma transacao (nao duplica aluno).
async function cademiEnviar(campos) {
  const corpo = new URLSearchParams();
  for (const [k, v] of Object.entries(campos)) if (v !== undefined && v !== null && v !== '') corpo.append(k, String(v));
  const r = await fetch(CADEMI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: corpo.toString()
  });
  const texto = await r.text().catch(() => '');
  return { ok: r.status === 200, status: r.status, corpo: texto.slice(0, 400) };
}

async function liberarNaCademi(evento, status) {
  if (!CADEMI_URL || !CADEMI_TOKEN) { console.log('Cademi nao configurada, pulando liberacao'); return false; }
  const itens = (evento.itens || []).filter((i) => i.code && i.code !== 'juros');
  if (!itens.length) { console.error('venda sem itens liberaveis', evento.order_id); return false; }

  let todosOk = true;
  for (const item of itens) {
    const produtoId = CADEMI_IDS[item.code];
    if (!produtoId) { console.error('produto sem cademi_id', item.code); todosOk = false; continue; }
    const r = await cademiEnviar({
      token: CADEMI_TOKEN,
      codigo: evento.order_id + '-' + item.code,
      status: status,
      produto_id: produtoId,
      produto_nome: item.descricao,
      valor: item.valor,
      cliente_email: evento.email,
      cliente_nome: evento.nome,
      cliente_doc: evento.documento,
      cliente_celular: (evento.telefone || '').replace(/\D/g, '')
    });
    if (r.ok) console.log('cademi ok', status, item.code, evento.email);
    else { todosOk = false; console.error('cademi FALHOU', item.code, evento.email, r.status, r.corpo); }
  }
  return todosOk;
}

// trava em memoria: impede que order.paid e charge.paid entreguem a mesma venda duas vezes
const emVoo = new Set();

// resolve o id do pedido a partir de um id de cobranca (ch_...)
async function pedidoDaCobranca(chargeId) {
  const r = await pagarme('/charges/' + encodeURIComponent(chargeId), 'GET');
  if (!r.ok) return null;
  return (r.json && r.json.order && r.json.order.id) || null;
}

// monta o evento e despacha UMA unica vez por pedido
async function entregarVenda(orderId, origem) {
  if (emVoo.has(orderId)) return { ja: true };
  emVoo.add(orderId);
  try {
    return await entregarVendaInterno(orderId, origem);
  } finally {
    emVoo.delete(orderId);
  }
}

async function entregarVendaInterno(orderId, origem) {
  const db = lerDb();
  const reg = db[orderId] || {};
  if (reg.entregue) return { ja: true };

  const r = await pagarme('/orders/' + encodeURIComponent(orderId), 'GET');
  if (!r.ok) { console.error('nao consegui ler o pedido', orderId); return { erro: true }; }
  const o = r.json;
  const charge = (o.charges || [])[0] || {};
  if (charge.status !== 'paid') return { naoPago: true };

  const c = o.customer || {};
  const evento = {
    evento: 'venda_paga',
    origem,
    order_id: o.id,
    codigo: o.code,
    valor: (o.amount || 0) / 100,
    metodo: charge.payment_method || 'pix',
    parcelas: parseInt((o.metadata || {}).parcelas || '1', 10),
    nome: c.name,
    email: c.email,
    documento: c.document || null,
    telefone: c.phones && c.phones.mobile_phone
      ? '+55' + c.phones.mobile_phone.area_code + c.phones.mobile_phone.number : null,
    itens: (o.items || []).map((i) => ({ code: i.code, descricao: i.description, valor: (i.amount || 0) / 100 })),
    metadata: o.metadata || {},
    pago_em: charge.paid_at || new Date().toISOString(),
    entregue_em: new Date().toISOString()
  };

  // abre o carimbo para o sGTM nao precisar decodificar nada
  evento.tdv = { id: '', fbp: '', fbc: '', ua: '', url: '', ip: '' };
  try {
    const bruto = (o.metadata || {}).tdv;
    if (bruto) Object.assign(evento.tdv, JSON.parse(Buffer.from(bruto, 'base64').toString('utf8')) || {});
  } catch (e) { console.error('carimbo tdv ilegivel', o.id, e.message); }

  // CAPI sem await bloqueante: rastreamento nunca atrasa nem derruba a entrega do aluno
  enviarCapi(evento).catch((e) => console.error('CAPI', e.message));

  const cademiOk = await liberarNaCademi(evento, 'aprovado');
  const n8nOk = N8N_WEBHOOK ? await repassarN8n(evento) : true;
  const ok = cademiOk && n8nOk;
  gravar(orderId, { status: 'paid', entregue: ok, cademi_ok: cademiOk, entregue_em: ok ? new Date().toISOString() : null, tentativas: (reg.tentativas || 0) + 1 });
  if (ok) console.log('venda entregue [' + origem + ']', orderId, evento.email, 'R$', evento.valor);
  else console.error('venda PAGA mas NAO entregue', orderId, evento.email, 'sera reprocessada');
  return { ok };
}

// rede de seguranca: de tempos em tempos confere pendentes e entrega o que ficou para tras
async function conferirPendentes() {
  const db = lerDb();
  const limite = Date.now() - JANELA_HORAS * 3600 * 1000;
  const alvos = Object.keys(db).filter((id) => {
    const p = db[id];
    if (p.entregue) return false;
    const t = Date.parse(p.criado_em || p.atualizado_em || 0);
    return !isNaN(t) && t > limite;
  });
  if (!alvos.length) return;
  console.log('conferindo', alvos.length, 'pedido(s) pendente(s)');
  for (const id of alvos) {
    try { await entregarVenda(id, 'conferencia'); } catch (e) { console.error('conferencia', id, e.message); }
  }
}

// ---------- servidor ----------
const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) { req.destroy(); reject(new Error('grande demais')); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

const responder = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const rota = url.pathname;

  try {
    if (rota === '/api/produtos' && req.method === 'GET') {
      return responder(res, 200, { ...PRODUTOS, pix_exige_cpf: PIX_EXIGE_CPF, max_parcelas: MAX_PARCELAS, juros_mes: JUROS_MES });
    }

    if (rota === '/api/pedido' && req.method === 'POST') {
      const ip = ipDoCliente(req);
      if (passouDoLimite(ip)) {
        console.error('limite de tentativas atingido', ip);
        return responder(res, 429, { erro: 'Muitas tentativas seguidas. Espere um minuto e tente de novo.' });
      }
      const dados = await lerCorpo(req);
      const r = await criarPedido(dados, ip);
      return responder(res, r.erro ? (r.status || 400) : 200, r);
    }

    if (rota === '/api/status' && req.method === 'GET') {
      const id = url.searchParams.get('order_id');
      if (!id) return responder(res, 400, { erro: 'informe order_id' });
      const r = await consultarPedido(id);
      return responder(res, r.erro ? 404 : 200, r);
    }

    // webhook da Pagar.me
    if (rota === '/api/webhook' && req.method === 'POST') {
      if (WEBHOOK_USER) {
        const h = req.headers['authorization'] || '';
        const esperado = 'Basic ' + Buffer.from(WEBHOOK_USER + ':' + WEBHOOK_PASS).toString('base64');
        if (h !== esperado) { res.writeHead(401); return res.end(); }
      }
      const corpo = await lerCorpo(req);
      const tipo = corpo.type || '';
      console.log('webhook recebido:', tipo, corpo?.data?.id || '');

      if (tipo === 'order.paid' || tipo === 'charge.paid') {
        const d = corpo.data || {};
        res.writeHead(200); res.end('ok');           // responde rapido, processa depois
        (async () => {
          // em order.paid o data e o pedido; em charge.paid o data e a cobranca
          let orderId = (d.order && d.order.id) || null;
          if (!orderId && typeof d.id === 'string') {
            orderId = d.id.startsWith('ch_') ? await pedidoDaCobranca(d.id) : d.id;
          }
          if (!orderId) return console.error('webhook sem order id', tipo, d.id);
          await entregarVenda(orderId, 'webhook');
        })().catch((e) => console.error('entrega', e.message));
        return;
      }
      res.writeHead(200); return res.end('ok');
    }

    // liberar acesso manualmente na Cademi, sem esperar o pagamento.
    // uso: casos de suporte, e teste da integracao. Protegido por usuario e senha.
    if (rota === '/api/liberar-manual' && req.method === 'POST') {
      const h = req.headers['authorization'] || '';
      const esperado = 'Basic ' + Buffer.from(WEBHOOK_USER + ':' + WEBHOOK_PASS).toString('base64');
      if (!WEBHOOK_USER || h !== esperado) { res.writeHead(401); return res.end(); }
      const dados = await lerCorpo(req);
      const id = dados.order_id;
      if (!id) return responder(res, 400, { erro: 'informe order_id' });
      const r = await pagarme('/orders/' + encodeURIComponent(id), 'GET');
      if (!r.ok) return responder(res, 404, { erro: 'pedido nao encontrado' });
      const o = r.json, c = o.customer || {};
      const evento = {
        order_id: o.id, nome: c.name, email: c.email, documento: c.document || null,
        telefone: c.phones && c.phones.mobile_phone ? '55' + c.phones.mobile_phone.area_code + c.phones.mobile_phone.number : null,
        itens: (o.items || []).map((i) => ({ code: i.code, descricao: i.description, valor: (i.amount || 0) / 100 }))
      };
      const ok = await liberarNaCademi(evento, 'aprovado');
      gravar(id, { liberado_manual: ok, liberado_manual_em: ok ? new Date().toISOString() : null });
      return responder(res, ok ? 200 : 502, { ok, itens: evento.itens.map((i) => i.code) });
    }

    // cancelar acesso na Cademi (reembolso). Protegido pelo mesmo usuario e senha do webhook.
    if (rota === '/api/cancelar' && req.method === 'POST') {
      const h = req.headers['authorization'] || '';
      const esperado = 'Basic ' + Buffer.from(WEBHOOK_USER + ':' + WEBHOOK_PASS).toString('base64');
      if (!WEBHOOK_USER || h !== esperado) { res.writeHead(401); return res.end(); }
      const dados = await lerCorpo(req);
      const id = dados.order_id;
      if (!id) return responder(res, 400, { erro: 'informe order_id' });
      const r = await pagarme('/orders/' + encodeURIComponent(id), 'GET');
      if (!r.ok) return responder(res, 404, { erro: 'pedido nao encontrado' });
      const o = r.json, c = o.customer || {};
      const evento = {
        order_id: o.id, nome: c.name, email: c.email, documento: c.document || null,
        telefone: c.phones && c.phones.mobile_phone ? '55' + c.phones.mobile_phone.area_code + c.phones.mobile_phone.number : null,
        itens: (o.items || []).map((i) => ({ code: i.code, descricao: i.description, valor: (i.amount || 0) / 100 }))
      };
      const ok = await liberarNaCademi(evento, 'cancelado');
      gravar(id, { cancelado: ok, cancelado_em: ok ? new Date().toISOString() : null });
      return responder(res, ok ? 200 : 502, { ok });
    }

    if (rota === '/health') { res.writeHead(200); return res.end('ok'); }

    // diagnostico: quantas vendas pagas ainda nao foram entregues
    if (rota === '/api/pendentes' && req.method === 'GET') {
      // expunha order_id, email e valor de venda sem autenticacao nenhuma
      const h = req.headers['authorization'] || '';
      const esperado = 'Basic ' + Buffer.from(WEBHOOK_USER + ':' + WEBHOOK_PASS).toString('base64');
      if (!WEBHOOK_USER || h !== esperado) { res.writeHead(401); return res.end(); }
      const db = lerDb();
      const pend = Object.values(db).filter((p) => p.status === 'paid' && !p.entregue);
      return responder(res, 200, {
        total_pedidos: Object.keys(db).length,
        pagos_nao_entregues: pend.length,
        pedidos: pend.map((p) => ({ order_id: p.order_id, email: p.email, valor: (p.total_centavos || 0) / 100, tentativas: p.tentativas || 0 }))
      });
    }

    // arquivos estaticos
    let arquivo = rota === '/' ? '/index.html' : rota;
    const caminho = path.join(__dirname, 'public', path.normalize(arquivo).replace(/^(\.\.[/\\])+/, ''));
    if (fs.existsSync(caminho) && fs.statSync(caminho).isFile()) {
      res.writeHead(200, { 'Content-Type': TIPOS[path.extname(caminho)] || 'application/octet-stream' });
      return fs.createReadStream(caminho).pipe(res);
    }
    res.writeHead(404); res.end('nao encontrado');
  } catch (e) {
    console.error('erro:', e);
    responder(res, 500, { erro: 'Erro interno. Tente de novo em instantes.' });
  }
});

server.listen(PORT, () => {
  console.log('checkout rodando na porta ' + PORT);
  console.log('conferencia de pendentes a cada ' + CONFERE_MIN + ' min, janela de ' + JANELA_HORAS + 'h');
  setTimeout(conferirPendentes, 20000);
  setInterval(conferirPendentes, CONFERE_MIN * 60 * 1000);
});
