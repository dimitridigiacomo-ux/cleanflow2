@AGENTS.md

## Specifico per Claude Code

- **Agenti di progetto** (`.claude/agents/`), da usare prima di ogni handoff che tocca lo scheduler:
  - `cleanflow-verifier` esegue le suite in `tools/harness/` e riporta la tabella PASS/FAIL;
  - `cleanflow-reviewer` fa una review in sola lettura del diff, con la checklist CleanFlow.
  - La review interna non sostituisce ancora quella indipendente (GPT): sulle modifiche al core dello scheduler restano entrambe, finché il confronto tra le due non dimostra il contrario.
- **Lo scratchpad di sessione è temporaneo.** Script e test che servono oltre la sessione vanno in `tools/`, i dati fuori dal repo. Il banco di prova è già andato perso una volta (ottobre 2026) ed è stato ricostruito dal transcript.
- **Modifiche a `index.html`**: usare Edit con ancore esatte o script Node che preservano i byte, poi controllare EOL e diff come da regola 6.
