# Checkout proprio - Do Zero ao Culto

Node 18+, sem dependencias externas.

## Variaveis de ambiente
| Variavel | Obrigatoria | Para que serve |
|---|---|---|
| PAGARME_SECRET_KEY | sim | chave secreta sk_ da Pagar.me |
| N8N_WEBHOOK_URL | nao | URL do fluxo do n8n que recebe a venda paga |
| WEBHOOK_USER | nao | usuario do basic auth que a Pagar.me envia no webhook |
| WEBHOOK_PASS | nao | senha do basic auth |
| PIX_EXIGE_CPF | nao | true para pedir CPF tambem no Pix (padrao false) |
| PIX_EXPIRA_SEG | nao | validade do Pix em segundos (padrao 3600) |
| MAX_PARCELAS | nao | ate quantas vezes no cartao (padrao 12) |
| JUROS_MES | nao | juros ao mes repassados ao comprador (padrao 0.0349) |
| PORT | nao | porta (padrao 3000) |

## Rotas
- GET  /                 pagina do checkout
- GET  /api/produtos     produtos, bumps e config de parcelamento
- POST /api/pedido       cria o pedido na Pagar.me e devolve o Pix
- GET  /api/status       consulta se o pedido foi pago
- POST /api/webhook      recebe order.paid da Pagar.me e repassa ao n8n
- GET  /health           usado pelo EasyPanel

## Trocar precos, textos e bumps
Edite produtos.json e reinicie o servico. Nao precisa mexer em codigo.

## Rede de seguranca (conferencia de pendentes)
O servidor guarda cada pedido em pedidos.json e marca `entregue: true` so depois que o
n8n confirmar o recebimento. De CONFERE_MIN em CONFERE_MIN minutos ele relê os pedidos
nao entregues das ultimas JANELA_HORAS horas, pergunta o status a Pagar.me e reenvia ao
n8n o que estiver pago e ainda nao entregue. Cada pedido e entregue uma unica vez.

Rota de diagnostico: GET /api/pendentes mostra quantas vendas foram pagas e ainda nao
chegaram ao n8n.

IMPORTANTE: monte um volume no EasyPanel apontando para DATA_DIR (ex.: /data) e defina
DATA_DIR=/data, senao o pedidos.json e apagado a cada deploy e a rede de seguranca perde
a memoria dos pedidos em aberto.

| Variavel | Padrao | Para que serve |
|---|---|---|
| CONFERE_MIN | 5 | intervalo da conferencia, em minutos |
| JANELA_HORAS | 48 | quanto tempo para tras conferir |
| DATA_DIR | pasta do app | onde gravar pedidos.json (use um volume) |
