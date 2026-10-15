Everything the patch changes in the game: what each feature does, how to use it while playing and which script in
the repository implements it. In-game names are given in Italian, as they appear in the patched game.

- [Translation](#translation)
- [Gameplay improvements](#gameplay-improvements)
  - [Shops and lessons at any hour](#shops-and-lessons-at-any-hour)
  - [Relationships with anyone](#relationships-with-anyone)
  - [Fast travel](#fast-travel)
  - [Fast text](#fast-text)
  - [The Options menu](#the-options-menu)
- [Game versions and saves](#game-versions-and-saves)
- [Known issues](#known-issues)

---

## Translation

| What | Details | Scripts |
|---|---|---|
| Texts | All dialogue, menus, items, clothes, recipes and character names. Names follow the European localization of the DS prequel (*Enchanted Folk and the School of Wizardry*) where they exist. | `build_text.py`, `build_tables.py`, `build_npc.py`, `blob_texts.py` |
| Feminine dialogue | When the character is a girl, the lines about her use feminine agreement ("Sei pronta?"). The game picks the ending by reading the sex of the profile. | `gender_tag.py` |
| 3-line boxes | The dialogue box shows 3 lines instead of 2, so Italian sentences, longer than Japanese, are not cut. | `build_code.py` |
| Full names | Clothes, accessories, wands and hats have their complete name, also on the Wizard License. | `license_names.py`, `build_code.py` |
| Signs and images | 3D shop signs, lesson blackboards, the *Spell & Spill* magazine (replacing *Berry's*), menu titles, credits and notices, redrawn in Italian in the original style. | `make_signs.py`, `make_tutorials.py`, `make_magazine*.py`, `make_credits.py`, `make_images.py` |
| Fonts | Accented letters and Italian symbols added to the game fonts. | `build_fonts.py`, `font_patch.py` |
| 24-hour clock | Italian time format throughout the game, bag clock included. | `build_code.py`, `build_ui.py` |
| Name keyboard | Opens on Latin letters (ABC) instead of Japanese. Proper names the word filter used to reject (Massimo, Cassandra…) are now accepted. | `build_code.py` |
| Boot without logos | The game starts straight at the title screen. | `make_logo_skip.py` |

---

## Gameplay improvements

They are designed as part of the game world: you ask the teachers for the options, and fast travel uses the smoke of
the Haunted House ghosts. None of them changes the save format.

### Shops and lessons at any hour

**What it does:** shops, the bank, the bar and the shopping mall services are open 24/7, and lessons can be taken at
any hour. Shop clerks no longer throw you out at midnight.

**How to use it:** nothing to do, it is always on.

**How it works:** opening hours live in the event scripts of the doors (`script.tarc`) and in a table of timed events
in the code. The patch sets the thresholds to "always open" and disables the closing events.
Scripts: `patch_shop_hours.py`, `build_code.py`.

### Relationships with anyone

**What it does:** you can become the partner or best friend of any villager, of any sex.

**How to use it:** give the **Bouquet d'invito** (Invitation Bouquet) to the villager (walk up to them, press **X**
and choose "Dare qualcosa"): they ask whether you mean **Amore** (love) or **Amicizia** (friendship). Magic cakes and
cookies can also have the romantic effect with anyone.

**How it works:** in the original game the bouquet script checked the sex of both characters; the patch replaces it
with your choice. About 160 lines about dating and couples were rewritten so that they fit every combination.
Script: `patch_relationships.py`.

### Fast travel

**What it does:** takes you anywhere in the village in an instant: you vanish in a puff of smoke and reappear at the
destination.

**How to use it:** open the **village Map** on the bottom screen, tap a place, then **tap the same icon again**. It can
be turned off from the [Options](#the-options-menu) menu.

**How it works:** a second tap on an already selected icon starts a new event with the same smoke effect the ghosts
use. Script: `fast_travel.py`.

### Fast text

**What it does:** while you hold **B**, dialogue text appears all at once instead of letter by letter.

**How to use it:** hold B while someone is talking. Menu choices are never confirmed automatically: you always choose
with A, so you can't answer by mistake.

**How it works:** the dialogue "typewriter" reads the newly pressed buttons to show the whole page; the patch also
passes it the held B button. Script: `options.py`.

### The Options menu

Some improvements can be switched on and off while playing, by asking a character.

**Where to find it:**
- **the teachers**, in the staff room: the **Opzioni** entry of their menu;
- **the teachers in front of the classroom**: the **Scegli il corso / Opzioni / Lascia** menu;
- **Reginaldo**, the dorm head: the **Opzioni** entry before "Lascia". Reginaldo is not much of a wizard, so he goes
  and asks the Principal to cast the spell for you (the screen briefly fades to black).

**The entries:**

| Entry | Effect | Default |
|---|---|---|
| **Viaggio rapido** | Turns [fast travel](#fast-travel) from the map on or off. | on |
| **Soldi infiniti** | Your wallet never goes down: you buy without spending. | off |
| **Legami stabili** | Love and friendship don't drop when you go days without seeing someone. | off |
| **Merce nuova** | Restocks every shop at once, Emporio della Magia included. One-shot, not a switch. | — |
| **Riusa materiali** | Spells don't use up the item you're holding: after the spell it goes back to the bag. | off |
| **Niente** | Closes the menu. | — |

The character tells you whether the spell was cast or lifted, so you always know if an option is on.

**How it works:** the choices are stored in save variables the game never uses (bank 1, bytes 0xEB and 0xFD–0xFF). A
new or existing save starts with everything as in the original game. The code patches read those variables: for
example "Riusa materiali" changes the mode the spell scripts use to empty your hand (from "destroy the item" to "put it
back in the bag"). Scripts: `options.py` (menu, character scripts and code), `build_text.py` (lines).

---

## Game versions and saves

- **A single patch for Ver.1.0 and Ver.1.1.** The patch already contains the translated code of the official 1.1
  update: it works with or without the update installed. The `.3ds` ROM created by the patch is already 1.1: don't
  install the update on top of it. Scripts: `port11.py` (moves the patches from 1.0 to 1.1 addresses), `build_code.py`.
- **Saves are compatible** with the original game: the patch doesn't change their format.
- **Downloadable content (DLC):** the game's online service closed in 2020 and the patch does not add it. Saves that contain it work normally.

## Known issues

- The shop name is limited to 12 characters.
- Some item and dish names are still abbreviated.
- A few minor textures are still in Japanese (some menus, the mail, the map, a few magazine pages).

Found a problem? Open an issue on the repository's **Issues** page, with a screenshot if you can.
