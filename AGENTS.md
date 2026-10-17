# CleanFlow — regole di progetto per agenti (Claude, Codex/GPT, altri)

CleanFlow pianifica i turni di pulizia di un portafoglio di affitti brevi a Malta.

- **Frontend**: un'unica SPA React in `index.html`. JSX tradotto nel browser da Babel standalone, nessun build step.
- **Backend**: Google Apps Script. Pubblica/ripristina le settimane e fa da proxy verso Hostaway.
  - **Non è su GitHub.** Una copia (`Code.gs`, `BO_Backend.gs`, `appsscript.json`) sta nel branch **locale** `main`, che ha una storia separata da `origin/main`: si legge con `git show main:Code.gs`.
  - Risale ad agosto 2026: prima di basarsi su di essa, va confrontata con il codice attualmente deployato nell'editor Apps Script.
- **Dati**: Google Sheets, letti come CSV pubblicati (`SHEET_URLS` in `index.html`).
- **Deploy**: GitHub Pages a ogni push su `main`.
- **Attenzione**: c'è `.nojekyll`, quindi **tutto ciò che è committato è pubblico** all'URL del sito, file nascosti compresi.

## Regole non negoziabili

1. **Niente commit, push, merge o deploy senza un ok esplicito del proprietario.** Push su `main` = produzione.
2. Si lavora su branch dedicati partiti da `origin/main`, mai direttamente su `main`.
3. **Stash `priority-final`** (`stash@{0}`, "DO NOT LOSE"):
   - non applicarlo né toccarlo;
   - non creare nuovi stash, perché sposterebbero gli indici.
4. **Dati privati.** I file in `../CleanFlowFixtures/` (replay, Debug, export) contengono nomi di ospiti, cleaner e proprietà:
   - solo lettura;
   - mai copiati nel repo;
   - mai citati nei report (si usano id e conteggi).
   - Lo stesso vale per qualunque export scaricato dall'app.
5. **Nessun segreto nel repo** (chiavi API, token). La chiave Gemini si legge da `localStorage`, non dal codice.
6. **Modifiche byte-precise a `index.html`.** Il file ha fine riga misti, CRLF e LF:
   - ogni modifica deve preservarli;
   - controllo: `git diff --numstat` deve coincidere con `git diff --ignore-space-at-eol --numstat`.
7. **Vincoli architetturali scelti dal proprietario:**
   - restano GitHub Pages, Apps Script, Google Sheets e gli URL attuali;
   - niente nuovi framework, database o bundler;
   - oggi l'app è un solo `index.html`. Separarla in file affiancati si fa solo seguendo un piano strutturale approvato.
8. **Direzione di evoluzione (no big-bang):** round-trip fedele → fixture/test → modello dati → core scheduler → qualità → back office.
   - **Non unificare** le implementazioni di eligibility (applicazione, pianificazione, diagnostica, trace): hanno scopi diversi.
   - Prima vanno caratterizzate.
9. **Export intoccabili.** L'export Supervisor XLSX (layout, colori, evidenziazioni, template) e l'export When I Work non si modificano. Le supervisor stampano il primo e lo usano ogni giorno. Una nuova funzione deve produrre esattamente lo stesso output in questi export.

## Verifica obbligatoria per modifiche allo scheduler

Qualsiasi modifica a scheduler, ricostruzione, fairness, solver o barriere va verificata così:

```
node tools/harness/verify-scheduler.js   # regressione vs origin/main + invarianti della rigenerazione parziale
node tools/harness/verify-solver.js      # solver locale + barriera max-worked-days
```

Devono finire con `ALL PASS`. Il controllo (1) "identico a origin/main" fallisce per costruzione se si cambia volutamente il comportamento dello scheduler: in quel caso la differenza va motivata nel report. Dettagli in `tools/harness/README.md`.

## Concetti del codice da rispettare

- **Parità app/replay.** `handleGenerate` e `runReplayFixture` devono ricostruire il piano in modo identico: stessi input, stesso ordine, stesse barriere. Chi tocca uno tocca l'altro.
- **Stato globale di modulo** (`__CF_REPLAY_NOW` e simili): ogni variabile impostata durante un run va salvata e ripristinata in `try/finally`.
- **Confine della rigenerazione parziale.** Lo scheduler valuta tutta la settimana, ma modifica solo i giorni nel range. `isMutableSchedulerJob` è il punto unico di controllo: non aggirarlo.
- **Job protetti.** Template bloccati da Sheet, modifiche manuali (`manualEdited`, `schedulerDecisionCode`) e rescue split non vengono mai toccati dai passaggi automatici.
- **Fallimenti espliciti.** Una generazione bloccata o fallita:
  - non produce artefatti di successo (fixture, trace `completed`, risultato applicabile);
  - chiude sempre il caricamento.
- **`detectConflicts` esclude di proposito il limite di giorni lavorati**, che è un vincolo settimanale: non "correggerlo" aggiungendolo lì.
- **Problema noto (round-trip).** Pubblica → ricarica perde campi dei job che lo scheduler usa: tra questi `manualEdited`, i `window*` di Hostaway e `templateLockedFromSheet`. Ogni nuovo campo dei job va verificato anche sul percorso di persistenza dell'Apps Script.

## Protocollo di consegna (handoff)

A fine task:

1. Scrivere `.handoff/CLAUDE_RESULT.md` (cartella ignorata da git) con:
   - diff (`--numstat` raw e ignore-eol);
   - test eseguiti ed esito;
   - stato git;
   - cosa resta aperto.
2. Rispondere "handoff aggiornato".
3. Fermarsi.

## Orientarsi in `index.html`

Il file è diviso in regioni con intestazioni `// ── NOME ──`. Si cercano per nome, perché i numeri di riga cambiano. In ordine:

- dati e parser Sheet;
- Hostaway;
- `CONFLICT ENGINE`;
- `AUTO-SCHEDULER` e passaggi successivi (optimizer, repair, fairness);
- validazioni ed export (WIW, Supervisor XLSX);
- `DEBUG CENTER` e replay;
- componenti UI;
- `ROOT` (`App`, con `handleGenerate`).
