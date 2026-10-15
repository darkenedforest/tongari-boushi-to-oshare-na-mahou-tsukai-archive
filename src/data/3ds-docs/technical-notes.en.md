A map of how Tongari Boushi to Mahou no Machi works (3DS, code.bin loaded at 0x100000), used to design the
gameplay improvements starting from the code rather than from trial and error. Main source: C decompiled with Ghidra
(not included: you get it by analysing your own code.bin), in `work/re/decomp/` (`code_XXXX.c` = functions from
0xXXXX0000, `functions.tsv` = index with callers and callees). The game running in Azahar is only used to confirm.

All addresses are for the Ver.1.0 code unless noted otherwise.

## 0. Memory and tools
- Segments (exheader): .text 0x100000-0x54ac88, .rodata 0x54b000 (0x3c5ec), .data 0x588000 (0x27f64), .bss 0x5b0000 (0x61ff4).
- Tools: Ghidra, an ARM disassembler (capstone), `scripts/evsc.py` (EVSC scripts), Azahar's GDB stub (`?` stops,
  Z0/Z2 breakpoint/watchpoint, after a hit z0 / s / Z0).
- Azahar ≠ 3DS: misaligned reads and reads from NULL don't crash in Azahar, but they do on a real console.

## 1. Game variables
- 0x160ad0(id) = read a variable; 0x11c170(id, val) = write.
- 1056876 = hour, 1056878 = minutes; 0x101282 = id of the playing character (0x1774 + slot).
- 3150105 = lesson time band chosen by Prof. Olmo (0 = 8-20, 1 = 12-24); 4306 = lesson shift (1/2/3 = teacher 2001/2002/2003, 0 none).
- Variable id encoding (FUN_0016d448): bits 20-21 type (0 byte, 1 u16, 2 u32, 3 bit), bits 16-18 bit index, bits 12-15 bank,
  bits 0-11 byte. Bank 1 = saved data. Free (no script, no constant in the code): bytes 249-255 and others.
- 4349 (0x10FD) = 1 fast travel off; 4350 (0x10FE) = 1 infinite money; 4351 (0x10FF) = 1 stable bonds
  (the Options menu, options.py).
- 8392 = index of the option chosen in a [$55] menu. Money: FUN_001c58ac() -> [0] cash (max 999999), [1] bank;
  FUN_001b222c(wallet, delta) adds/removes, FUN_001b266c(wallet, value) sets, FUN_001aea30 sets the bank.

## 2. Text and dialogue
- Message parser 0x1336bc (state: dst [st+0xc], cap [st+0x10] = 192 units); tag dispatcher [$500..599] 0x133924,
  handler table 0x597dac (gender_tag.py uses [$599]).
- Dialogue window 0x33d934: clones Txt_mes_win into a TextBox (ctor 0x42d828 -> 0x4333e0) with a 0x40 buffer -> patched to 0x80.
  TextBox: vtable 0x57aa54, TextBuf +0xd4, bufBytes +0xf8, len +0xfa; AllocStringBuffer 0x122ba0 (vtable+0x70).
  Another clone at 0x35afb4 with 0x31 characters (window not identified).
- Choice options: 16 characters fill the buffer with no terminator -> 15 at most.
- Showing a message: 0x10cfa0 -> 0x11f3a0 -> 0x132f24; reads (file, id) with 0x1332ac.

## 3. Scripts
- EVSC (evscript/actscript in script.tarc): see `scripts/evsc.py` (op061 dialogue, op05e warp, op08e/op08f variables...).
- Byte-command interpreter (doors and map objects): 0x4826f4, op table 0x591684 (u8 op + arguments; op 0x45 = message
  with a u16 id). Runs command by command from a buffer (e.g. 0x880efa8), copy at 0x3937a8 (lr 0x392bbc <- 0x3b3c20 <- 0x306114).
  From the C: FUN_004826f4(cmd, ...) checks cmd[0] <= 0x78, per-op flags in DAT_00482838, then jumps through the table.
  FUN_003937a8(obj) = executor: obj+0x2c = current command; before running it, it calls FUN_00392670(obj, obj+0x2c),
  which prepares the command (state machine on obj+0x66; ops 0x73/0x77 -> replace the argument with a 0x160ad0
  variable and become 0x70/0x74). Other callers of the interpreter: 0x2d4xxx (code_002d.c:4169), 0x31xxxx (code_0031.c:8354/8390).
  Open question: where a door's command list comes from (who fills obj+0x2c / the queue before 0x392670).

## 4. Opening hours
- Lessons: 0x27c92c computes the shift only inside the band [r5, r8) -> 24/7 patch (0x27C938/40/80).
- Generic "lesson hours" condition 0x2a93d0 (condition evaluator 0x2a9xxx, hour = [obj+0x88]+4): not touched.
- Clock: FUN_0010d258() = date/time structure (*(DAT_0010d26c+4)+0x4f8); [+4] u32: byte0 = hour, byte1 = minutes.
  45 functions read it.
- Timed trigger evaluator (from the C): FUN_002a9664(list) walks 16-byte records (*param_1, count param_1[0x24])
  and calls FUN_002a9264(obj, rec) for each. Record: s16 [0] who (-1 everyone, -2, -3 = table DAT_002a9660, otherwise an id),
  s8 [2] = hour1, u8 [3] = hour2 or a code: <0x18 band hour1..hour2 inclusive (also across midnight);
  100/0x65 hour ==/!=, 0x66-0x69 comparisons, 0x6a = lesson hours (variable DAT_002a965c: 1 -> 12..23, otherwise 8..19),
  0x6c/0x6d/0x6f-0x71/0x7e other conditions. [8] u32 variable id (0xffffff = none), [5] operator, [6] u16 value.
- TIMED TRIGGER TABLE (.rodata 0x54d0a8-0x54d298, 16-byte records; GDB + C): [0] s16 map (-1 everywhere, -2/-3 special),
  [2] s8 hour (-1 = none), [3] code: <0x18 = band [2]..[3], 0x64 hour ==, 0x7e hour == and minutes >= 50, 0x6a lesson hours...;
  [4] type (0/3 = set NPC state with FUN_001d6d70([8],[0xc]), 1 = start event [0xc]*100+[0xe] via 0x394a98, 6 = variable 3211524
  -> closing music BGM 0x42 on maps 45/46/52, 2/4/5/7/8 other); [5]/[6]/[8] condition on a variable.
  Evaluated by FUN_002a9664 -> FUN_002a9264 (conditions) -> FUN_002a97c4 (action). Shop closing: type 1 at 0:00 (bar 4:00)
  -> events 21x80 (the clerk throws you out), 224000 (hall), 300180. The patch sets the hour to 99 (build_code INSN_PATCHES).
- Starting events: FUN_001d6b48(group, index, ...) -> FUN_00394370(mgr, group, index) -> FUN_003406bc: script id = group*100 + index
  (binary search in evscript.rndx). Execution: FUN_00394980 -> FUN_0039466c -> loader FUN_00305be0 (EVSC signature).
- Event calendar (from the C): FUN_002d4734(date, slot, rec, ...) = "is this record active now?"; slot = hour*2 + (min >= 30).
  12-byte rec: two dates [0..3] start / [4..7] end (b0 = week<<4|weekday, b1 = month, b2 = day or <0 = n-th
  weekday, b3 = hour, -1 = from a callback), [8]/[9] = parameters. FUN_002392d4(obj, &table, n, ...) finds the first
  active event (indices 0-58 and 100+). Used for seasonal events and fairs (0x23b1ec, 0x23b474, 0x23be18; 0x2d4xxx), not for shops.
- Shops and services (solved with GDB + evscript): the opening hours are in the EVSC SCRIPTS of the doors, not in the code.
  Touching a door -> evscript (VM 0x306xxx: nodes with opcode argc<<16|op at +0x20, ops < 0x1e internal, the others through the vtable;
  FUN_003b3bbc = generic custom op: builds a byte command (type = op - 0x1e) with the constructors in table 0x592a30
  and runs it with the 0x4826f4 interpreter). op063(id, 0, 1) = system message -> command 0x45 -> FUN_0047ef64 ->
  FUN_002d0b3c (mgr+0x2fa8) -> FUN_002d0674 -> 0x10cfa0 shows the message (id 5400+n = 99054.n).
  Door scripts (evscript.rdbt): 25552 bank (5407), 25534 (5401), 25550 (5406), 25666 (5401), 250005 (5729 = 99057.29),
  25611/25612 shared (local variable #fffffffc = building: 51/376 -> 5400, 55 -> 5402, 57 bar -> 5403, 58 -> 5404, 60 -> 5405).
  Condition: op016(op007(op08f(1056876), 9), open) = if hour >= 9 jump to the "open" branch, otherwise op063(54xx).
  Bar (57): op019(op009(hour, 3), op007(hour, 8)) = hour <= 3 OR hour >= 8. op007 = >=, op009 = <=, op019 = OR.
  After the hour check there is also op063(5300) (another closing condition, variable 1056810 == 2): not touched.
  Tool: the id of the running script is at vm+0x38 (0x4652 = 18002 = internal id, NOT the bank id); the EVSC block is
  in RAM (vm+0x7c) and can be found in the bank by comparing bytes.
- common.tarc: TimeZone.bin = light/sky bands (float); MapPlaneModel.bin = 530 models x 632 bytes (ASCII strings).

## 5. Profiles and saves
- 0x185bb4(slot) = address of the NAME in the profile (slot*0x4b4; RAM 0x5cf64c); sex = name+0x48 (1 = female).
- tc4_common.sav: profiles at 0x11b2c + slot*0x4b4.

## 6. Menus and UI
- MenuFile.bin (common.tarc) = menu id -> layout; .dmst = parts in order; 0x207648 part lookup, 0x152e94 animation,
  0x11c808 opens a menu. Never remove DMST parts or layout panes the code looks up (crash on 3DS).

## 7. Relationships (couples of any sex)
- **op061(npc, 252, line)**: file 252 = 0xfc = the speaker's personality file (40-45 male, 46-51 female), 251 = 0xfb = per-speaker
  file of group 40 (invitations/confessions). In the line engine FUN_00132f24(obj, type, id, speaker): type 0xfc
  = line in the personality file, 0xfb = script id. Id in the file = (group % 1000) * 100 + slot (40002.85 -> 285).
- Points: relationship table, a 0x104 block per villager (13): love +0xb8+player, friendship +0xbc+player (whole bytes,
  fraction kept apart), between villagers +0xcc+i. FUN_001b592c = change points (bonuses/tables); FUN_004a1048 = increase from
  an interaction; vt+0x1e4/+0x1e8 read/set. Daily DECAY: FUN_001c65dc (villagers not met, table * days,
  minimum threshold) -> bl FUN_001b592c(-points) at 0x1c69e4. Initialisation 32-36: FUN_001b91ec/FUN_001c5b84.
- Group x002: 0-66 reactions to gifts (script 105003), 69 "best friends?", 70-72 "dating?", 73 yes, dating,
  75/76 Lovers' Point, 78/79 no, 81/82 yes, friends, 84 you already have a partner, 85 same-sex refusal (now DEAD), 86 you already
  have a friend, 88-90 already bonded, 92 lives far away. "Racing heart" event 128060: same sex -> 28, different -> 31.
- **128080 = Invitation Bouquet** given to villager 8080. op06c(342, who) = sex (0 = player); op06c(206) != 0 -> 292;
  op06c(188) = relationship state (3 friends, 4 dating) -> 288; op06c(148/156) = number of the player's partners/friends
  (FUN_001c2b58(mgr, 4|3, ...)); op06c(189/151) = love/friendship points (vt+0x1e4 of the actor, type 0/1; add = vt+0x1e8).
  Choice 3307/3308 -> variable 8392. op04e(npc, 0, 4|3) = becomes partner/friend. op06c handlers: table 0x591ab0 (511 entries) via
  FUN_0049eb54; result in variable 1056768.
- Patch (patch_relationships.py): the "Love/Friendship" choice 3308 replaces the same-sex flag (1049260); with the same
  sex, if love is < 80, friendship >= 80 counts (the dead code of line 285 is reused). Model of every combination.
- **105003 gifts**: variable 40 = the player's sex (compared with 0/1 in many scripts). Magic cake/cookie: only between different
  sexes is there a romantic reaction (200/204/205: op04f(npc, 0, 43) = +43 love, then a date via 3539565; 220/223: +24), otherwise
  a generic one (201/202). Patch: the "same sex" branch jumps to the romantic one too (0x1ab0, 0x21f0). op04f(npc, 0|1, n) = +love|friendship points.
- Villager invitations: 70001 (partner: 1053328, hour 4309) / 70003 (friend: 1053330, 4315); confessions 70101/70111 and
  70103/70113. Who picks 70001 or 70003 was not found (not a literal): they stay as in the original game.
- Text: tags [$599] o/a and [$598] i/e (gender_tag.py) by the player's sex; m130/m131/m132 make the partner neutral
  (groups x002, x016 break-ups, x065 chats with the partner, xx052 Your Highness, Unicorn 33028, letters 98057, 2x047). The rest
  (2x040 invitations, x015/x038/x039/98054) talks about couples between villagers or stays in the original flow: unchanged.
- Player's sex: profile + 0x48 from the name (profile base *(DAT_00185be4+4) + slot*0x4b4 + 0x11714 -> sex at +0x1175c);
  character structure +0x17 (setter FUN_001b68bc); FUN_001c2aa8() = the player's character.
- Conversation topic conditions: FUN_0028faf8 (record +0x3b = required sex of the player, -1 any).
- **Ghidra**: turn off "Non-Returning Functions - Discovered" (FUN_0011be8c/FUN_00131594 are getters: it cut 386 functions short).
- Shop note: the closing script 21980 (NPC 3004, "そろそろ店を閉めるぜ") is not started by any table found
  (group 219/80 is absent from code.bin and romfs): probably unused.

## 8. Maps, warps and fast travel
- Maps: 0xffff = the village field (exits: destination 0x5f16a8 = 65535); 353 = Shopping mall (rtmap_entrance: shops
  45/46/51/52/55/57/58/60 -> 353); 6 School, 9 Haunted House, 14 Dorm, 42 Apartment, 53 Tower, 61 Post office, 62 Bank,
  64 Beach/Event Hall/Abracadabra area (181), 49 Lovers' Point, 67 Island, 182/183 Castle, 343/344 Event Hall.
  global.tarc/rtmap_entrance.bin = s16[343]: map -> "root" map. Pseudo-maps 0xfff6-0xfffa = houses (dynamic return
  list 0x5f24d8, 12 x 0x18, FUN_001f4a48), resolved by FUN_00178db4 -> FUN_00181c24.
- Map change: FUN_002401a4(field, mode, map, transition, extra) with the position in s0-s2. Mode 0 = field (destination
  forced to 0xffff; if map < 0xff it calls FUN_004e5054), mode 1 = map resolved by FUN_00178db4. Wrappers: FUN_002d0548
  (mode 0, command 'A'), FUN_002d0570 (mode 1, command '@'); object *0x59280c. Static player position 0x5f06c0.
- EVSC script -> byte commands: op N -> command N - 0x1e (table 0x554b94), run by FUN_004826f4 (table 0x591684).
  op05e(map,x,y,z) -> '@' (u16 map, s16 xyz*128, u16 0xff); op05f(255,x,y,z) -> 'A' (field). op05e(65535) = black screen.
- Effects: op040(actor, dx, dy, 1, id, frame) = particle effect effect.tarc/ef_<id> (35 = smoke cloud, 24 = sparkles);
  op040(..., 0, 341/342...) = camera; op065(sound, vol); op04c(actor, 0/1) = hide/show; op045(...,4096) = music.
  Haunted House ghost = scripts 5501/5503 (take you to the Dorm, 14). Clean arrival: op06d; op04c(0,0); op06c(79,1000);
  op06e; op06c(17).
- Village map: menu 161, FUN_0038b6b8 opens it, FUN_0038bd30 states, FUN_0038b1f4 input (0x38b3e8 = tap on the already
  selected icon -> fast travel, scripts/fast_travel.py, events 1202xx).

## 9. Inventory, wardrobe, DLC
- Bag: 15 entries of 6 bytes at FUN_001cfea4() (u16 id, 3 attribute bytes, u8 quantity at +5, stacks of 9 max; empty = 40 bits 0xff).
  FUN_001a4e7c adds to the bag (-1 full), FUN_001a640c finds a stack, FUN_001a1098 stackable?, FUN_001a0b68 removes.
- Home wardrobe = 30 entries at FUN_001ca13c(); FUN_001a04a8(wardrobe, entry, n) adds (inserts at the top if there is no stack).
  Screen = menu 0x46 chest_bg (ui/menu_chest), FUN_0029a3a4/FUN_00299098, works on a copy and saves on OK.
- Quantity drawn as one animation per number (FUN_00332718, 2..9). Item definitions: item_common 001.bin (12 bytes).
- DLC: ids from 6500 (0x1964); romfs pre_download/dlitem_XXXX.tarc (23, code 0x2842fc); downloaded into extdata:/download/
  from the tongari4.konamionline.com server (closed in 2020). Ownership in tc4_common.sav (0x34 / 0x26388).
- Effects: op040 -> FUN_004821e8 -> FUN_002f3384 -> FUN_0037b8c8(mgr, id, actor slot, ...); the fast travel smoke is
  not visible when leaving from the shopping mall (353): under investigation.
- DLC always on (disabled since 1.9, dlc.ENABLED): scripts/dlc.py (boot state machine 0x396ba0 state 0x36 -> states 0x3a/0x3b,
  asynchronous writer FUN_0020ebac, worker case 7 doesn't free the buffer). Shopping mall = common+0x25820: active +0x540
  (32x4: active, type, id), waiting +0x750 (50), history +0x5c0 (100); FUN_0010d2f4 registers (max 5 DLC of type 5); rotation
  FUN_001c383c only with AEON (ownership type 0 id 0) and byte 3 of the dlshop bin (1 leaves / 2 enters).

## 10. Spells, the typewriter, buttons
- op06c handlers: table 0x591ab0; dispatcher 0x49eb54 (called from 0x47e51c: r0 = subcode [cmd+2], argument [cmd+4]
  integer -> r0 of the handler). op06c(18, mode) = 0x4835bc empties the hand: 0 = item to the bag (vt+0x164(actor, item, 1)),
  1 = destroyed, 2/3 = same for vt+0x160. op06c(20, n) = FUN_002d4150 (not items). op06c(8) doesn't empty the hand.
- Spells = EVSC scripts 31001-36101, 133101-133501 (town), 303025/026 (aurora); messages 99030/99031 with op063(3000+n)
  (system message id = (bank-99000)*100+n). xx02 = failure, xx04 = variant without consumption. 303100 = atelier cat.
  Wand magic 37xxx/38xxx/129xxx: nothing in hand is consumed. Patch: options.SPELLS (mode 4 + variable 4331).
- Low tags [$0..99] of the parser: table 0x597dac (substitutions: names, items); [$12] and others have no handler.
- Dialogue typewriter: FUN_0033de74 state 6; window +0x308 TextBox (per-character colours in TextBox+0x108,
  setter FUN_0042d058(tb, idx, &col)); 1 character every [+0x17a] frames (+0x30d counter), +0x180 shown,
  +0x186 total; whole page if pressed & 0x403 or [+0x177]. Fast text patch: 0x33e358 (options.FAST).
- Pad: FUN_0010cc30(&out, *0x5afd4c) -> out[0] held, [1] pressed, [2] released, [3] ?, [4..5] stick. 0x403 = A|B|X.
- Reginaldo = npc 2013, menu 32082.4 (jumps in the text), 8392 read by 302108 only for Yes/No (32082.84) and the gift (.94).
- Bag (1.1): *(0x593f08 + 0xc) + 0x12 (1.0: 0x592f08), 15 slots of 6 bytes: u16 item NUMBER, 00 00 00, u8 quantity;
  empty = ff ff ff ff ff 00. The item number is NOT the name index: item_table.tarc/ItemNoList.itnt = u32 n +
  pairs (u16 number, u16 ItemName name index). E.g. Aquamarine = 901 (name 426), Turquoise = 906 (name 431).
