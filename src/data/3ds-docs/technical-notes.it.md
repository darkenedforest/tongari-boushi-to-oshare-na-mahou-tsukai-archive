Mappa di come funziona Tongari Boushi to Mahou no Machi (3DS, code.bin a 0x100000) per progettare le QoL partendo
dal codice, non dai test. Fonte principale: C decompilato da Ghidra (non incluso: si ottiene analizzando il proprio code.bin) in `work/re/decomp/` (`code_XXXX.c` = funzioni
da 0xXXXX0000, `functions.tsv` = indice con chiamanti/chiamate). Il gioco in Azahar serve solo a confermare.

## 0. Memoria e strumenti
- Segmenti (exheader): .text 0x100000-0x54ac88, .rodata 0x54b000 (0x3c5ec), .data 0x588000 (0x27f64), .bss 0x5b0000 (0x61ff4).
- Strumenti: Ghidra, un disassemblatore ARM (capstone), `scripts/evsc.py` (script EVSC),
  lo stub GDB di Azahar ( `?` ferma, Z0/Z2 breakpoint/watchpoint, dopo un hit z0 / s / Z0).
- Azahar ≠ 3DS: letture disallineate o da NULL non crashano in Azahar.

## 1. Variabili di gioco
- 0x160ad0(id) = leggi variabile; 0x11c170(id, val) = scrivi.
- 1056876 = ora, 1056878 = minuti; 0x101282 = id del personaggio giocante (0x1774 + slot).
- 3150105 = fascia lezioni scelta da Olmo (0 = 8-20, 1 = 12-24); 4306 = turno lezione (1/2/3 = prof 2001/2002/2003, 0 nessuno).
- Codifica id variabile (FUN_0016d448): bit 20-21 tipo (0 byte, 1 u16, 2 u32, 3 bit), bit 16-18 indice del bit, bit 12-15 banco,
  bit 0-11 byte. Banco 1 = dati salvati. Liberi (nessuno script, nessuna costante nel codice): byte 249-255 ecc.
- 4349 (0x10FD) = 1 viaggio rapido spento; 4350 (0x10FE) = 1 soldi infiniti; 4351 (0x10FF) = 1 legami stabili
  (opzioni del Prof. Olmo, options.py).
- 8392 = indice dell'opzione scelta in un menu [$55]. Soldi: FUN_001c58ac() -> [0] contanti (max 999999), [1] banca;
  FUN_001b222c(portafoglio, delta) aggiunge/toglie, FUN_001b266c(portafoglio, valore) imposta, FUN_001aea30 imposta la banca.

## 2. Testi e dialoghi
- Parser messaggi 0x1336bc (stato: dst [st+0xc], cap [st+0x10] = 192 unità); dispatcher tag [$500..599] 0x133924,
  tabella gestori 0x597dac (gender_tag.py usa [$599]).
- Finestra dialogo 0x33d934: clona Txt_mes_win in un TextBox (ctor 0x42d828 -> 0x4333e0) con buffer 0x40 -> patch 0x80.
  TextBox: vtable 0x57aa54, TextBuf +0xd4, bufBytes +0xf8, len +0xfa; AllocStringBuffer 0x122ba0 (vtable+0x70).
  Altro clone 0x35afb4 con 0x31 caratteri (finestra non identificata).
- Opzioni di scelta: 16 caratteri riempiono il buffer senza terminatore -> massimo 15.
- Mostra messaggio: 0x10cfa0 -> 0x11f3a0 -> 0x132f24; legge (file, id) con 0x1332ac.

## 3. Script
- EVSC (evscript/actscript in script.tarc): vedi `scripts/evsc.py` (op061 dialogo, op05e warp, op08e/op08f variabili...).
- Interprete di comandi a byte (porte e oggetti mappa): 0x4826f4, tabella op 0x591684 (op u8 + argomenti; op 0x45 = messaggio
  con id u16). Esecuzione comando per comando in un buffer (es. 0x880efa8), copia 0x3937a8 (lr 0x392bbc <- 0x3b3c20 <- 0x306114).
  Dal C (Ghidra 13/10): FUN_004826f4(cmd, ...) controlla cmd[0] <= 0x78, flag per op in DAT_00482838, poi salta alla tabella.
  FUN_003937a8(obj) = esecutore: obj+0x2c = comando corrente, prima di eseguirlo chiama FUN_00392670(obj, obj+0x2c)
  che prepara il comando (macchina a stati su obj+0x66; ops 0x73/0x77 -> sostituisce l'argomento con una variabile
  0x160ad0 e diventano 0x70/0x74). Altri chiamanti dell'interprete: 0x2d4xxx (code_002d.c:4169), 0x31xxxx (code_0031.c:8354/8390).
  Prossimo: da dove arriva la lista dei comandi della porta (chi riempie obj+0x2c / la coda prima di 0x392670).

## 4. Orari
- Lezioni: 0x27c92c calcola il turno solo nella fascia [r5, r8) -> patch 24/7 (0x27C938/40/80). FATTO 1.2.
- Condizione generica "ore di lezione" 0x2a93d0 (valutatore di condizioni 0x2a9xxx, ora = [obj+0x88]+4): non toccata.
- Orologio: FUN_0010d258() = struttura data/ora (*(DAT_0010d26c+4)+0x4f8); [+4] u32: byte0 = ora, byte1 = minuti.
  45 funzioni la leggono (elenco: grep FUN_0010d258 in work/re/decomp).
- Valutatore di trigger a orario (C 13/10): FUN_002a9664(lista) scorre record da 16 byte (*param_1, conteggio param_1[0x24])
  e per ciascuno chiama FUN_002a9264(obj, rec). Record: s16 [0] chi (-1 tutti, -2, -3 = tabella DAT_002a9660, altrimenti id),
  s8 [2] = ora1, u8 [3] = ora2 oppure codice: <0x18 fascia ora1..ora2 inclusa (anche a cavallo della mezzanotte);
  100/0x65 ora ==/!=, 0x66-0x69 confronti, 0x6a = ore di lezione (var DAT_002a965c: 1 -> 12..23, altrimenti 8..19),
  0x6c/0x6d/0x6f-0x71/0x7e altre condizioni. [8] u32 id variabile (0xffffff = nessuna), [5] operatore, [6] u16 valore.
  Non usato (per ora) per i negozi.
- TABELLA TRIGGER ORARI (.rodata 0x54d0a8-0x54d298, record da 16 byte; GDB + C 13/10): [0] s16 mappa (-1 ovunque, -2/-3 speciali),
  [2] s8 ora (-1 = nessuna), [3] codice: <0x18 = fascia [2]..[3], 0x64 ora ==, 0x7e ora == e minuti >= 50, 0x6a ore di lezione...;
  [4] tipo (0/3 = imposta stato NPC con FUN_001d6d70([8],[0xc]), 1 = avvia evento [0xc]*100+[0xe] via 0x394a98, 6 = var 3211524
  -> musica di chiusura BGM 0x42 nelle mappe 45/46/52, 2/4/5/7/8 altro); [5]/[6]/[8] condizione su variabile.
  Valutati da FUN_002a9664 -> FUN_002a9264 (condizioni) -> FUN_002a97c4 (azione). Chiusura negozi: tipo 1 alle 0:00 (bar 4:00)
  -> eventi 21x80 (il commesso caccia fuori), 224000 (sala), 300180. Patch 1.2: ora -> 99 (build_code INSN_PATCHES).
- Avvio eventi: FUN_001d6b48(gruppo, indice, ...) -> FUN_00394370(mgr, gruppo, indice) -> FUN_003406bc: id script = gruppo*100 + indice
  (ricerca binaria in evscript.rndx). Esecuzione: FUN_00394980 -> FUN_0039466c -> loader FUN_00305be0 (firma EVSC).
- Calendario eventi (C 13/10): FUN_002d4734(data, fascia, rec, ...) = "il record è attivo ora?"; fascia = ora*2 + (min >= 30).
  rec 12 byte: due date [0..3] inizio / [4..7] fine (b0 = settimana<<4|giorno-sett., b1 = mese, b2 = giorno o <0 = n-esimo
  giorno della settimana, b3 = ora, -1 = da callback), [8]/[9] = parametri. FUN_002392d4(obj, &tabella, n, ...) cerca il primo
  evento attivo (indici 0-58 e 100+). Usato per eventi stagionali/fiere (0x23b1ec, 0x23b474, 0x23be18; 0x2d4xxx), non per i negozi.
- Negozi/servizi (RISOLTO 13/10, GDB + evscript): l'orario sta negli SCRIPT EVSC delle porte, non nel codice.
  Porta toccata -> evscript (VM 0x306xxx: nodi con opcode argc<<16|op a +0x20, op < 0x1e interni, gli altri via vtable;
  FUN_003b3bbc = op custom generico: costruisce un comando a byte (tipo = op - 0x1e) con i costruttori della tabella 0x592a30
  e lo esegue con l'interprete 0x4826f4). op063(id, 0, 1) = messaggio di sistema -> comando 0x45 -> FUN_0047ef64 ->
  FUN_002d0b3c (mgr+0x2fa8) -> FUN_002d0674 -> 0x10cfa0 mostra il messaggio (id 5400+n = 99054.n).
  Script delle porte (evscript.rdbt): 25552 banca (5407), 25534 (5401), 25550 (5406), 25666 (5401), 250005 (5729 = 99057.29),
  25611/25612 condiviso (variabile locale #fffffffc = edificio: 51/376 -> 5400, 55 -> 5402, 57 bar -> 5403, 58 -> 5404, 60 -> 5405).
  Condizione: op016(op007(op08f(1056876), 9), aperto) = se ora >= 9 salta al ramo "aperto", altrimenti op063(54xx).
  Bar (57): op019(op009(ora, 3), op007(ora, 8)) = ora <= 3 OR ora >= 8. op007 = >=, op009 = <=, op019 = OR.
  Dopo il controllo orario c'è anche op063(5300) (altra condizione di chiusura, var 1056810 == 2): non toccata.
  Strumento: l'id dello script in esecuzione è a vm+0x38 (0x4652 = 18002 = id interno, NON l'id del banco); il blocco EVSC è
  in RAM (vm+0x7c) e si ritrova nel banco confrontando i byte.
- common.tarc: TimeZone.bin = bande di luce/cielo (float); MapPlaneModel.bin = 530 modelli x 632 byte (stringhe ASCII).

## 5. Profili e salvataggio
- 0x185bb4(slot) = indirizzo del NOME nel profilo (slot*0x4b4; RAM 0x5cf64c); sesso = nome+0x48 (1 = femmina).
- tc4_common.sav: profili a 0x11b2c + slot*0x4b4.

## 6. Menu e UI
- MenuFile.bin (common.tarc) = id menu -> layout; .dmst = parti in ordine; 0x207648 ricerca parte, 0x152e94 animazione,
  0x11c808 apre un menu. Mai togliere parti DMST o pannelli cercati dal codice (crash su 3DS).

## 7. Relazioni (QoL 7, FATTA 13/10: coppie di qualsiasi sesso)
- **op061(npc, 252, riga)**: file 252 = 0xfc = file carattere del parlante (40-45 maschi, 46-51 femmine), 251 = 0xfb = file
  per-parlante del gruppo 40 (inviti/dichiarazioni). Nel motore delle battute FUN_00132f24(obj, tipo, id, parlante): tipo 0xfc
  = riga nel file carattere, 0xfb = id script. Id nel file = (gruppo % 1000) * 100 + slot (40002.85 -> 285).
- Punti: tabella relazioni, blocco 0x104 per abitante (13): amore +0xb8+giocatore, amicizia +0xbc+giocatore (byte interi,
  frazione a parte), tra abitanti +0xcc+i. FUN_001b592c = cambia punti (bonus/tabelle); FUN_004a1048 = aggiunta da
  interazione; vt+0x1e4/+0x1e8 leggi/imposta. CALO giornaliero: FUN_001c65dc (abitanti non incontrati, tabella * giorni,
  soglia minima) -> bl FUN_001b592c(-punti) a 0x1c69e4. Inizializzazione 32-36: FUN_001b91ec/FUN_001c5b84.
- Gruppo x002: 0-66 reazioni ai regali (script 105003), 69 "amici per la pelle?", 70-72 "fidanzati?", 73 si' fidanzati,
  75/76 Punta degli Innamorati, 78/79 no, 81/82 si' amici, 84 hai gia' un partner, 85 rifiuto stesso sesso (MORTO), 86 hai gia'
  un amico, 88-90 gia' legati, 92 abita lontano. Evento "cuore che batte" 128060: stesso sesso -> 28, diversi -> 31.
- **128080 = Bouquet d'invito** regalato all'abitante 8080. op06c(342, chi) = sesso (0 giocatore); op06c(206) != 0 -> 292;
  op06c(188) = stato relazione (3 amici, 4 fidanzati) -> 288; op06c(148/156) = numero di fidanzati/amici del giocatore
  (FUN_001c2b58(mgr, 4|3, ...)); op06c(189/151) = punti amore/amicizia (vt+0x1e4 dell'attore, tipo 0/1; add = vt+0x1e8).
  Scelta 3307/3308 -> var 8392. op04e(npc, 0, 4|3) = diventa fidanzato/amico. Gestori op06c: tabella 0x591ab0 (511 voci) via
  FUN_0049eb54; risultato in var 1056768.
- Patch (patch_relationships.py): la scelta 3308 "Amore/Amicizia" sostituisce il flag stesso-sesso (1049260); con lo stesso
  sesso, se l'amore e' < 80 vale l'amicizia >= 80 (codice morto della riga 285 riusato). Modello di tutte le combinazioni.
- **105003 regali**: var 40 = sesso del giocatore (confrontata con 0/1 in molti script). Torta/biscotto magico: solo tra sessi
  diversi reazione romantica (200/204/205: op04f(npc, 0, 43) = +43 amore, poi appuntamento via 3539565; 220/223: +24) altrimenti
  generica (201/202). Patch C: il ramo "stesso sesso" salta anch'esso al romantico (0x1ab0, 0x21f0). op04f(npc, 0|1, n) = +punti amore|amicizia.
- Inviti dell'abitante: 70001 (fidanzato: 1053328, ora 4309) / 70003 (amico: 1053330, 4315); dichiarazioni 70101/70111 e
  70103/70113. Chi sceglie 70001 o 70003 non e' stato trovato (non letterale): restano come nel gioco originale.
- Testo: tag [$599] o/a e [$598] i/e (gender_tag.py) secondo il sesso del giocatore; m130/m131/m132 neutralizzano il partner
  (gruppi x002, x016 rotture, x065 chiacchiere col partner, xx052 Sua Altezza, Unicorno 33028, lettere 98057, 2x047). Il resto
  (2x040 inviti, x015/x038/x039/98054) parla di coppie tra abitanti o resta nel flusso originale: invariato.
- Sesso del giocatore: profilo + 0x48 dal nome (base profili *(DAT_00185be4+4) + slot*0x4b4 + 0x11714 -> sesso a +0x1175c);
  struttura personaggio +0x17 (setter FUN_001b68bc); FUN_001c2aa8() = personaggio del giocatore.
- Condizioni degli argomenti di conversazione: FUN_0028faf8 (record +0x3b = sesso richiesto del giocatore, -1 qualsiasi).
- **Ghidra**: disattivare "Non-Returning Functions - Discovered" (FUN_0011be8c/FUN_00131594 sono getter: tagliava 386 funzioni).
- Nota negozi: lo script di chiusura 21980 (NPC 3004, "そろそろ店を閉めるぜ") non e' avviato da nessuna tabella trovata
  (gruppo 219/80 assente in code.bin e romfs): probabilmente inutilizzato.

## 8. Mappe, warp e viaggio rapido (13/10)
- Mappe: 0xffff = campo del villaggio (uscite: destinazione 0x5f16a8 = 65535); 353 = Centro commerciale (rtmap_entrance: negozi
  45/46/51/52/55/57/58/60 -> 353); 6 Scuola, 9 Casa infestata, 14 Dormitorio, 42 Appartamento, 53 Torre, 61 Posta, 62 Banca,
  64 zona Spiaggia/Sala Eventi/Abracadabra (181), 49 Punta degli Innamorati, 67 Isola, 182/183 Castello, 343/344 Sala Eventi.
  global.tarc/rtmap_entrance.bin = s16[343]: mappa -> mappa "radice". Pseudo-mappe 0xfff6-0xfffa = case (lista di rientro
  dinamica 0x5f24d8, 12 x 0x18, FUN_001f4a48), risolte da FUN_00178db4 -> FUN_00181c24.
- Cambio mappa: FUN_002401a4(campo, modo, mappa, transizione, extra) con posizione in s0-s2. Modo 0 = campo (destinazione
  forzata 0xffff; se mappa < 0xff chiama FUN_004e5054), modo 1 = mappa risolta da FUN_00178db4. Wrapper: FUN_002d0548
  (modo 0, cmd 'A'), FUN_002d0570 (modo 1, cmd '@'); oggetto *0x59280c. Posizione giocatore statica 0x5f06c0.
- Script EVSC -> comandi a byte: op N -> comando N - 0x1e (tabella 0x554b94), eseguiti da FUN_004826f4 (tabella 0x591684).
  op05e(mappa,x,y,z) -> '@' (u16 mappa, s16 xyz*128, u16 0xff); op05f(255,x,y,z) -> 'A' (campo). op05e(65535) = schermo nero.
- Effetti: op040(attore, dx, dy, 1, id, frame) = effetto particellare effect.tarc/ef_<id> (35 = nuvola di fumo, 24 = scintille);
  op040(..., 0, 341/342...) = camera; op065(suono, vol); op04c(attore, 0/1) = nascondi/mostra; op045(...,4096) = musica.
  Fantasma della Casa infestata = script 5501/5503 (porta al Dormitorio 14). Arrivo pulito: op06d; op04c(0,0); op06c(79,1000);
  op06e; op06c(17).
- Mappa del villaggio: menu 161, FUN_0038b6b8 apre, FUN_0038bd30 stati, FUN_0038b1f4 input (0x38b3e8 = tocco sull'icona gia'
  selezionata -> viaggio rapido, scripts/fast_travel.py, eventi 1202xx).

## 9. Inventario, armadio, DLC (13/10)
- Borsa: 15 voci da 6 byte a FUN_001cfea4() (u16 id, 3 byte attributi, u8 quantita' a +5, pila max 9; vuoto = 40 bit 0xff).
  FUN_001a4e7c aggiungi alla borsa (-1 piena), FUN_001a640c cerca pila, FUN_001a1098 impilabile?, FUN_001a0b68 togli.
- Armadio di casa = 30 voci a FUN_001ca13c(); FUN_001a04a8(armadio, voce, n) aggiunge (inserisce in testa se nessuna pila).
  Schermata = menu 0x46 chest_bg (ui/menu_chest), FUN_0029a3a4/FUN_00299098, lavora su una copia e salva con OK.
- Quantita' disegnata come animazione per numero (FUN_00332718, 2..9). Definizioni oggetti: item_common 001.bin (12 byte).
- DLC: id da 6500 (0x1964); romfs pre_download/dlitem_XXXX.tarc (23, codice 0x2842fc); scaricati in extdata:/download/
  dal server tongari4.konamionline.com (chiuso 2020). Possesso in tc4_common.sav (0x34 / 0x26388).
- Effetti: op040 -> FUN_004821e8 -> FUN_002f3384 -> FUN_0037b8c8(mgr, id, slot attore, ...); fumo del viaggio rapido
  non visibile partendo dal centro commerciale (353): in indagine (fx_log.py).
- (14/10) DLC sempre attivi (disattivati dalla 1.9, dlc.ENABLED): scripts/dlc.py (macchina di avvio 0x396ba0 stato 0x36 -> stati 0x3a/0x3b, writer FUN_0020ebac
  asincrono, worker caso 7 non libera il buffer). Centro commerciale = common+0x25820: attivi +0x540 (32x4: attivo,tipo,id),
  attesa +0x750 (50), storico +0x5c0 (100); FUN_0010d2f4 registra (max 5 DLC tipo 5); rotazione FUN_001c383c solo con AEON
  (possesso tipo 0 id 0) e byte 3 del dlshop bin (1 esce / 2 entra).

## Incantesimi, macchina da scrivere, tasti (14/10 notte)
- Gestori op06c: tabella 0x591ab0; dispatcher 0x49eb54 (chiamato da 0x47e51c: r0 = sottocodice [cmd+2], argomento [cmd+4]
  intero -> r0 del gestore). op06c(18, modo) = 0x4835bc svuota la mano: 0 = oggetto in borsa (vt+0x164(att, ogg, 1)),
  1 = distrutto, 2/3 = idem per vt+0x160. op06c(20, n) = FUN_002d4150 (non oggetti). op06c(8) non svuota la mano.
- Incantesimi = script EVSC 31001-36101, 133101-133501 (citta'), 303025/026 (aurora); messaggi 99030/99031 con op063(3000+n)
  (id messaggio di sistema = (banco-99000)*100+n). xx02 = fallimento, xx04 = variante senza consumo. 303100 = gatto atelier.
  Magie della bacchetta 37xxx/38xxx/129xxx: nessun consumo in mano. Patch: options.SPELLS (modo 4 + var 4331).
- Tag basse [$0..99] del parser: tabella 0x597dac (sostituzioni: nomi, oggetti); [$12] ecc. senza gestore.
- Macchina da scrivere dialoghi: FUN_0033de74 stato 6; finestra +0x308 TextBox (colori per carattere in TextBox+0x108,
  setter FUN_0042d058(tb, idx, &col)); 1 carattere ogni [+0x17a] fotogrammi (+0x30d contatore), +0x180 mostrati,
  +0x186 totale; pagina intera se premuti & 0x403 o [+0x177]. Patch testo veloce: 0x33e358 (options.FAST).
- Pad: FUN_0010cc30(&out, *0x5afd4c) -> out[0] tenuti, [1] premuti, [2] rilasciati, [3] ?, [4..5] stick. 0x403 = A|B|X.
- Reginaldo = npc 2013, menu 32082.4 (salti nel testo), 8392 letto da 302108 solo per Si/No (32082.84) e regalo (.94).
- Borsa (1.1): *(0x593f08 + 0xc) + 0x12 (1.0: 0x592f08), 15 posti da 6 byte: u16 NUMERO oggetto, 00 00 00, u8 quantità;
  vuoto = ff ff ff ff ff 00. Il numero oggetto NON è l'indice del nome: item_table.tarc/ItemNoList.itnt = u32 n +
  coppie (u16 numero, u16 indice nome ItemName). Es. Acquamarina = 901 (nome 426), Turchese = 906 (nome 431).
