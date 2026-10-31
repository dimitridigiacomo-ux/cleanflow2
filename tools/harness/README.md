# Banco di prova dello scheduler

Esegue lo scheduler **vero** di `index.html` in Node, sulle settimane reali salvate come replay fixture, e controlla che una modifica non rompa niente.

Non serve nessuna dipendenza: basta Node 18+ e git.

```
node tools/harness/verify-scheduler.js   # regressione + invarianti rigenerazione parziale
node tools/harness/verify-solver.js      # solver locale + barriera max-worked-days
node tools/harness/verify-hostaway-merge.js   # re-import Hostaway "solo novità" (dati sintetici, pochi secondi)
```

Exit code 0 = `ALL PASS`. Le prime due suite impiegano 1–3 minuti ciascuna.

`verify-hostaway-merge.js` non usa fixture: prova `mergeHostawayImportJobs` con prenotazioni inventate. Copre: import identico, prenotazione nuova, ospiti cambiati, finestra cambiata (con e senza spostamento dell'orario), turni manuali e rescue protetti, checkout che diventa B2B, prenotazione cancellata (solo segnalata), dati persi al ricaricamento ripristinati in silenzio, fallback dello scheduler, chiavi duplicate, nota della supervisor, CSV, altre settimane e template. Controllo di sensibilità: togliendo la protezione dei turni manuali, i controlli 6 e 7 falliscono.

## Opzioni

| Flag | Effetto |
|---|---|
| `--baseline <ref>` | confronto con un'altra versione (default `origin/main`) |
| `--current <ref>` | testa un ref git invece del working tree, senza checkout |
| `--fixtures a.json,b.json` | altre fixture (nome nella cartella fixture o percorso assoluto) |

## Fixture: dati PRIVATI

Le fixture stanno **fuori dal repo**, in `../CleanFlowFixtures/` (accanto alla cartella del repo), oppure dove indica la variabile `CLEANFLOW_FIXTURES`.

- Contengono nomi reali di ospiti, cleaner e proprietà: non vanno mai copiate qui dentro.
- Le suite stampano solo id e conteggi.
- Una fixture si ottiene dall'app: Debug Center → scarica replay fixture, dopo una generazione.

## Cosa controlla

`verify-scheduler.js`, per ogni fixture:

| # | Controllo |
|---|---|
| 1 | Generazione della settimana intera identica alla baseline. Fallisce **per costruzione** se lo scheduler cambia di proposito: in quel caso la differenza va motivata. |
| 2 | Rigenerando Lun–Mer: Gio–Dom invariati, nessun nuovo superamento dei giorni massimi, nessun conflitto reale. |
| 3 | Le cleaner oltre il limite di giorni non aumentano. |
| 4 | Genera → Rigenera → Rigenera converge. |
| 5 | Nessun job duplicato o perso. |
| 6 | Template bloccati, modifiche manuali e rescue split non vengono toccati. |
| 7 | Il replay di una generazione la riproduce identica. |
| 9 | Il piano interno dello scheduler non tocca i giorni fuori range. |

`verify-solver.js`:

| # | Controllo |
|---|---|
| 8a–c | Il solver locale non raccomanda mai un nuovo superamento dei giorni; la barriera blocca un'azione forzata. |
| P1a | `runReplayFixture` su un candidato oltre il limite restituisce un errore di fase `max_worked_days`. Per ottenere quel candidato la suite simula una regressione: alza il limite dello scheduler, lasciando alla barriera il limite vero. |
| P1b | La baseline dell'app e quella del replay bloccano lo stesso candidato. |
| P1c | Una fixture reale fa replay normalmente. |
| P2a/b | Superamento preesistente: consentito se la mossa non lo peggiora, con motivazione onesta; rifiutato se lo peggiora. |
| V | Il conteggio dei giorni considera solo giorni validi. |

## Come funziona

`engine.js` estrae da `index.html` le dichiarazioni di primo livello che servono, con il brace-matching e la chiusura transitiva da una lista di "semi". Poi le valuta in Node con i globali di dominio presi dalla fixture. `index.html` non viene mai modificato.

`sim.js` replica in Node la ricostruzione che fa `handleGenerate` nella rigenerazione parziale.

Controllo di sensibilità: `--current origin/main` (prima della patch max-days) deve **fallire** sui controlli 2 e 9. Se un giorno passasse, le suite non starebbero più rilevando quel bug.
