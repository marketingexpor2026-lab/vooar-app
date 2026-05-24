# Como publicar o backend VOOAR no Google Apps Script

## Passo a passo

### 1. Abra o Google Apps Script
Acesse: https://script.google.com/

### 2. Crie um novo projeto
- Clique em **"Novo projeto"**
- Apague o código padrão que aparece

### 3. Cole o código
- Copie todo o conteúdo do arquivo `Code.gs` (nesta pasta)
- Cole no editor do Apps Script

### 4. Salve o projeto
- Pressione **Ctrl+S** (ou Cmd+S)
- Dê um nome ao projeto: ex. `VOOAR Backend`

### 5. Publique como Web App
- Clique em **"Implantar"** → **"Nova implantação"**
- Em **"Tipo"**, selecione **"Aplicativo da Web"**
- Configure:
  - **Executar como:** Eu (seu e-mail do Google)
  - **Quem tem acesso:** Qualquer pessoa
- Clique em **"Implantar"**
- Autorize o acesso ao Google Drive quando pedido
- **Copie a URL gerada** (começa com `https://script.google.com/macros/s/...`)

### 6. Configure no VOOAR
- Abra o editor VOOAR
- Na seção **"Armazenamento na Nuvem"**, cole a URL copiada
- Clique em **"Salvar"**
- A pílula de status deve mudar para **"Drive ativo ☁️"**

---

## O que o Apps Script faz

| Ação | O que acontece |
|------|---------------|
| Upload de imagem/vídeo | Salva no Drive, retorna URL pública |
| Salvar projeto | Grava `projects_<uid>.json` no Drive |
| Listar projetos | Lê o JSON e retorna array |
| Deletar projeto | Remove entrada do JSON |
| Ping | Confirma que o script está ativo |

---

## Estrutura criada no Drive

```
📁 Sua pasta VOOAR (1wuXGqtKxCcz56euNLlLBKsidwbNSaC8E)
├── 📁 images/         ← imagens gatilho
├── 📁 videos/         ← vídeos AR
└── 📁 data/
    ├── projects_<uid>.json
    └── users.json
```

---

## Atenção: arquivo .mind

O arquivo `.mind` **não é enviado ao Drive** — ele fica no **IndexedDB do navegador** do dispositivo que criou o projeto. Isso resolve o problema de CORS que impediria o MindAR de carregar o arquivo remotamente.

Se quiser usar o AR em outro dispositivo, abra o editor naquele dispositivo e faça upload do `.mind` novamente (o projeto já estará sincronizado pelo Drive).
