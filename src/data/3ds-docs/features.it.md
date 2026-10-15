Questa pagina descrive tutto ciò che la patch cambia nel gioco: cosa fa ogni funzione, come si usa in partita e quale
script del repository la realizza.

- [Traduzione](#traduzione)
- [Miglioramenti di gioco](#miglioramenti-di-gioco)
  - [Negozi e lezioni a ogni ora](#negozi-e-lezioni-a-ogni-ora)
  - [Relazioni con chiunque](#relazioni-con-chiunque)
  - [Viaggio rapido](#viaggio-rapido)
  - [Testo veloce](#testo-veloce)
  - [Il menu Opzioni](#il-menu-opzioni)
- [Versioni del gioco e salvataggi](#versioni-del-gioco-e-salvataggi)
- [Problemi noti](#problemi-noti)

---

## Traduzione

| Cosa | Dettagli | Script |
|---|---|---|
| Testi | Tutti i dialoghi, i menu, gli oggetti, i vestiti, le ricette e i nomi dei personaggi. I nomi seguono la localizzazione europea del prequel per DS (*Enchanted Folk and the School of Wizardry*), dove esistono. | `build_text.py`, `build_tables.py`, `build_npc.py`, `blob_texts.py` |
| Dialoghi al femminile | Se il personaggio è una ragazza, le battute che la riguardano si accordano al femminile ("Sei pronta?"). Il gioco sceglie la desinenza leggendo il sesso del profilo. | `gender_tag.py` |
| Riquadri a 3 righe | Il riquadro dei dialoghi mostra 3 righe invece di 2, così le frasi italiane, più lunghe del giapponese, non vengono tagliate. | `build_code.py` |
| Nomi interi | Vestiti, accessori, bacchette e cappelli hanno il nome completo, anche nella Patente da mago. | `license_names.py`, `build_code.py` |
| Insegne e immagini | Insegne 3D dei negozi, lavagne delle lezioni, rivista *Spell & Spill* (al posto di *Berry's*), titoli dei menu, crediti e avvisi, ridisegnati in italiano nello stile dell'originale. | `make_signs.py`, `make_tutorials.py`, `make_magazine*.py`, `make_credits.py`, `make_images.py` |
| Font | Lettere accentate e simboli italiani aggiunti ai font del gioco. | `build_fonts.py`, `font_patch.py` |
| Orologio a 24 ore | Ore nel formato italiano in tutto il gioco, orologio della borsa compreso. | `build_code.py`, `build_ui.py` |
| Tastiera del nome | Si apre sulle lettere (ABC) invece che sul giapponese. I nomi propri che il filtro delle parole rifiutava (Massimo, Cassandra…) ora sono accettati. | `build_code.py` |
| Avvio senza loghi | Il gioco parte subito dalla schermata del titolo. | `make_logo_skip.py` |

---

## Miglioramenti di gioco

Sono pensati come parte del mondo del gioco: le opzioni le chiedi ai professori, il viaggio rapido usa il fumo dei
fantasmi della Casa infestata. Nessuno cambia il formato dei salvataggi.

### Negozi e lezioni a ogni ora

**Cosa fa:** negozi, banca, bar e servizi del centro commerciale sono aperti 24 ore su 24, e le lezioni si seguono a
qualsiasi ora. I commessi non ti cacciano più a mezzanotte.

**Come si usa:** niente da fare, è sempre attivo.

**Come funziona:** gli orari stanno negli script degli eventi delle porte (`script.tarc`) e in una tabella di eventi
orari nel codice. La patch porta le soglie a "sempre aperto" e disattiva gli eventi di chiusura.
Script: `patch_shop_hours.py`, `build_code.py`.

### Relazioni con chiunque

**Cosa fa:** puoi diventare fidanzato/a o amico/a per la pelle di qualsiasi abitante, di qualsiasi sesso.

**Come si usa:** regala il **Bouquet d'invito** all'abitante (avvicinati, premi **X** e scegli "Dare qualcosa"):
ti chiede se intendi **Amore** o **Amicizia**. Anche torte e biscotti magici possono avere l'effetto romantico con
chiunque.

**Come funziona:** nel gioco originale lo script del bouquet controllava il sesso dei due personaggi; la patch lo
sostituisce con la tua scelta. Circa 160 battute su corteggiamento e coppia sono state riscritte perché tornino in ogni
combinazione. Script: `patch_relationships.py`.

### Viaggio rapido

**Cosa fa:** ti sposta in un attimo in qualsiasi luogo del villaggio: sparisci in una nuvola di fumo e ricompari a
destinazione.

**Come si usa:** apri la **Mappa del villaggio** sullo schermo basso, tocca un luogo e poi **tocca di nuovo la stessa
icona**. Si può spegnere dal menu [Opzioni](#il-menu-opzioni).

**Come funziona:** il secondo tocco su un'icona già selezionata avvia un evento nuovo con lo stesso effetto di fumo che
usano i fantasmi. Script: `fast_travel.py`.

### Testo veloce

**Cosa fa:** tenendo premuto **B** il testo dei dialoghi compare tutto subito invece che lettera per lettera.

**Come si usa:** tieni premuto B mentre qualcuno parla. Le scelte nei menu non vengono confermate da sole: si sceglie
sempre con A, così non si risponde per sbaglio.

**Come funziona:** la "macchina da scrivere" dei dialoghi legge i tasti appena premuti per mostrare la pagina intera; la
patch le passa anche il tasto B tenuto premuto. Script: `options.py`.

### Il menu Opzioni

Alcuni miglioramenti si accendono e si spengono in partita, chiedendoli a un personaggio.

**Dove si trova:**
- **i professori**, in sala professori: voce **Opzioni** del loro menu;
- **i professori davanti all'aula**: menu **Scegli il corso / Opzioni / Lascia**;
- **Reginaldo**, il capo del dormitorio: voce **Opzioni** prima di "Lascia". Reginaldo non è un gran mago, quindi va a
  chiedere al Preside di lanciare la magia per te (lo schermo si oscura per un attimo).

**Le voci:**

| Voce | Effetto | Predefinito |
|---|---|---|
| **Viaggio rapido** | Accende o spegne il [viaggio rapido](#viaggio-rapido) dalla mappa. | acceso |
| **Soldi infiniti** | Il portafoglio non scende mai: compri senza spendere. | spento |
| **Legami stabili** | Amore e amicizia non calano se passi dei giorni senza vedere qualcuno. | spento |
| **Merce nuova** | Rifornisce subito tutti i negozi, Emporio della Magia compreso. Si usa una volta, non è un interruttore. | — |
| **Riusa materiali** | Gli incantesimi non consumano l'oggetto che tieni in mano: dopo la magia torna nella borsa. | spento |
| **Niente** | Chiude il menu. | — |

Il personaggio conferma a voce se la magia è stata lanciata o sciolta, quindi sai sempre se un'opzione è accesa.

**Come funziona:** le scelte vengono salvate in variabili del salvataggio che il gioco non usa (banco 1, byte 0xEB e
0xFD–0xFF). Un salvataggio nuovo o già esistente parte con tutto come nel gioco originale. Le patch del codice leggono
quelle variabili: per esempio "Riusa materiali" cambia la modalità con cui gli script degli incantesimi svuotano la mano
(da "distruggi l'oggetto" a "rimettilo in borsa"). Script: `options.py` (menu, script dei personaggi e codice),
`build_text.py` (battute).

---

## Versioni del gioco e salvataggi

- **Una sola patch per Ver.1.0 e Ver.1.1.** La patch contiene già il codice dell'aggiornamento ufficiale 1.1 tradotto:
  funziona con o senza l'aggiornamento installato. La ROM `.3ds` creata dalla patch è già 1.1: non installarci sopra
  l'aggiornamento. Script: `port11.py` (porta le patch dagli indirizzi 1.0 a quelli 1.1), `build_code.py`.
- **Salvataggi compatibili** con il gioco originale: la patch non ne cambia il formato.
- **Contenuti scaricabili (DLC):** il servizio online del gioco è chiuso dal 2020 e la patch non li aggiunge. I salvataggi che li contengono funzionano normalmente.

## Problemi noti

- Il nome del negozio ha al massimo 12 caratteri.
- Alcuni nomi di oggetti e piatti sono ancora abbreviati.
- Poche texture minori sono ancora in giapponese (alcuni menu, la posta, la mappa, qualche pagina della rivista).

Hai trovato un problema? Apri una segnalazione nella pagina **Issues** del repository, con una foto dello schermo se
puoi.
