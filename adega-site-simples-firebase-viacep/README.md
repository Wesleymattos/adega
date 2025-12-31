
# Adega — Site simples (Firebase + ViaCEP)

## O que tem
- `index.html` + `js/app.js`: lista vinhos do Firebase, calcula frete (grátis ≥ R$ 100), consulta **ViaCEP** (valida e mostra cidade/UF) e grava **orders** + **requests**.
- `motoboy.html` + `js/motoboy.js`: painel do motorista/motoboy para **aceitar** solicitações em 10s e avançar status.
- `css/styles.css`: estilos básicos.

## Como rodar
```bash
cd adega-site-simples-firebase-viacep
python -m http.server 5500
# abra: http://localhost:5500/index.html e http://localhost:5500/motoboy.html
```

## Regras (temporárias) do Realtime Database
Use regras mais abertas para o protótipo (depois endurecemos com Auth):
```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "settings": { ".read": true, ".write": false },
    "wines": { ".read": true, ".write": false },
    "deliveryPersons": { ".read": true, ".write": true },
    "orders": { ".read": true, ".write": true },
    "requests": { ".read": true, ".write": true }
  }
}
```

## Fluxo
1. Motoboy: ative **Ana (carro)** ou **Carlos (motoboy)**.
2. Cliente: adicione vinhos, digite CEP, aguarde validação (ViaCEP) e clique **Solicitar Entrega**.
3. Motoboy: aceite em até 10s, avance status **to_adega** → **to_customer**.

## Observações
- Se você importou o JSON em um nó diferente (ex.: `/adega`), ajuste os caminhos nos `ref(...)` para `adega/settings`, `adega/wines` etc.
- Em produção, ativar **Auth** e regras condicionais por perfil.
