"""
Update overlays.json with semantic decode data for ov000, ov001, and ov157.

These three overlays have been fully decoded (every function has a semantic
name, C body, struct decode, and role summary). This script patches the
JSON with the decode metadata and per-function role_hint updates.
"""

import json
import sys
from pathlib import Path

OVERLAYS_JSON = Path(__file__).resolve().parent.parent / "public" / "data" / "overlays.json"

# ── ov000 updates ──────────────────────────────────────────────────────────

OV000_UPDATES = {
    "purpose_summary": (
        "Audition minigame — spell-naming/dictation game where the player "
        "selects correct kana sequences for spells NPCs know. Touch-screen "
        "candidate grid with scroll, cursor, OK/Cancel. Loads data/2d/audition.lzs. "
        "All visible text from RESO type 99 string registry — zero in-overlay "
        "translation surface."
    ),
    "decode_status": "full",
    "decode_function_count": 37,
    "decode_note": (
        "37/37 functions decoded (35 Ghidra + 2 vtable-only). "
        "All 5 UTF-16 hits were Thumb instruction false positives."
    ),
    "translation_surface_summary": (
        "Zero translatable strings inside overlay. All 5 UTF-16 hits are "
        "Thumb instruction false positives. Visible text from RESO type 99 "
        "string registry + data/2d/audition.lzs OFS records (untranslated in v2.4.2)."
    ),
}

OV000_FUNC_HINTS = {
    "0x02155ce4": "renderer_request_release_5() — sets bit 5 on renderer status byte",
    "0x02155cf4": "renderer_request_release_1() — sets bit 0 on renderer status byte",
    "0x02155d04": "scene_tick() [vtable 3] — 9-state main game loop. States: load_palettes → wait_assets → wait_render → fade_in → interactive_loop → fade_out → swap_pages → release",
    "0x02156204": "is_fade_done() — returns 1 when fade animation complete",
    "0x02156214": "scene_render_vsync() [vtable 4] — per-VBlank sprite push. Iterates 4 top-screen + 8 bottom-screen sprite headers, pushes cursor + alt-card overlay",
    "0x0215635c": "top_screen_bg_init() — allocates 4-sprite top-screen background from audition.lzs",
    "0x02156454": "top_screen_bg_destroy() — frees top-screen BG draw list",
    "0x02156484": "bottom_screen_bg_init() — allocates 8-sprite bottom-screen BG with OK/Cancel buttons",
    "0x0215655c": "bottom_screen_bg_destroy() — frees bottom-screen BG draw list",
    "0x02156590": "interactive_frame_handler() — 1352 bytes. Heart of state 5: cursor refresh, idle/swap gate, hotspot polling, DPad dispatch, inactivity timeout, swap animation",
    "0x02156af8": "cursor_refresh() — detects cursor position change, triggers label relayout",
    "0x02156b6c": "hitbox_test(idx) — tests touch position against 8-entry hitbox table at 0x02157ed4",
    "0x02156bd0": "set_cursor_zone(zone, sfx_flag) — maps input zone 0..7 to cursor position, plays SFX 400",
    "0x02156c40": "card_select_at_cursor() — plays SFX 0x192, sets selected_card_idx from cursor position",
    "0x02156c78": "commit_cancel() — cancel commit. Guard: no slot busy. SFX 0x192, page-A swap anim, rewind direction",
    "0x02156d00": "commit_ok() — OK commit. SFX 0x191, forward swap anim, refresh page-0 glyphs if on page 1",
    "0x02156d6c": "commit_scroll_up() — SFX 0x2bb, scroll-up animation, timer_swap=6",
    "0x02156de0": "commit_scroll_down() — SFX 0x191, scroll-down animation, timer_swap=6",
    "0x02156e1c": "lay_out_labels(mode) — 956 bytes. Builds per-card text labels. Fetches strings from RESO type 99 (IDs 0x2a1c–0x2a26). Mode 0=relayout, Mode 1=full rebuild",
    "0x021571f8": "page_meta_sync() — refreshes swap_anim_state from NSC metadata (stage indicator + mode)",
    "0x021572f8": "disable_scroll_chevrons() — controls scroll-chevron animator direction",
    "0x02157318": "register_scene_graph_nodes() — attaches 2 scheduler nodes via arm9 0x0200e510",
    "0x02157384": "unregister_scene_graph_nodes() — detaches from scene scheduler",
    "0x02157398": "preload_card_glyphs(page) — 3-pass glyph preloader: base/highlighted/shadow variants per card",
    "0x021574b8": "request_card_renderers() — requests up to 4+1 card renders from renderer pool",
    "0x02157554": "request_render() — trampoline to func_0x021599d8 (renderer pool)",
    "0x02157568": "is_no_slot_busy() — returns 1 if no card in lifecycle state 1 (precondition for OK/Cancel)",
    "0x0215759c": "card_animation_step() — 1044 bytes. Per-frame scroll latch, scroll step, state-3 collection, state-1/2 positioning, state-4 retry",
    "0x021579c4": "release_all_card_slots() — frees all 4 renderer pool slots, resets card lifecycles",
    "0x02157a38": "is_spell_opcode(npc_iter, opcode) — filters message opcodes 0x14–0x26 for spell content",
    "0x02157b1c": "card_passes_double_filter() — calls is_spell_opcode for both sides, returns 1 only if both pass",
    "0x02157b70": "seed_cards_from_npc_spells() — 780 bytes. Init-time card seeder: builds 140-entry table, shuffles, sorts by weight, filters by NPC friendship tier",
    "0x02157e7c": "swap_u32(a, b) — swaps a pair of u16s",
    "0x02157e88": "scene_attach_to_scheduler() [vtable 0] — initializes embedded scheduler list node",
    "0x02157e9c": "scene_detach_from_scheduler() [vtable 1] — re-inits list node, notifies arm9",
}

# ── ov001 updates ──────────────────────────────────────────────────────────

OV001_UPDATES = {
    "purpose_summary": (
        "Bank deposit/withdraw UI — single-purpose banking scene where the "
        "player deposits or withdraws Ritch (currency). 6-digit amount entry via "
        "DPad or touch. Asymmetric caps: wallet 999,999 vs bank 9,999,999. Loads "
        "data/2d/bank_in.lzs (deposit) or bank_out.lzs (withdraw). Zero in-overlay "
        "translation surface."
    ),
    "decode_status": "full",
    "decode_function_count": 33,
    "decode_note": (
        "33/33 functions decoded (30 Ghidra + 3 vtable-only). "
        "Single UTF-16 hit is a Thumb instruction false positive."
    ),
    "translation_surface_summary": (
        "Zero translatable strings inside overlay. Single UTF-16 hit at "
        "0x02155f4a is a Thumb instruction false positive. All visible text "
        "from NCGR glyph tiles in bank_in.lzs / bank_out.lzs containers "
        "(untranslated in v2.4.2)."
    ),
}

OV001_FUNC_HINTS = {
    "0x02155a74": "scene_draw_obj() [vtable 5] — per-frame object draw pass. Releases sprites, draws arrow OAM, releases sound bank",
    "0x02155af4": "scene_draw_bg() [vtable 4] — per-frame BG pass. Draws amount row + palette setup when in running/exit_delay phase",
    "0x02155b14": "set_mode(mode) — clamps mode byte to 0 (deposit) or 1 (withdraw)",
    "0x02155b24": "update_load_phase() — phase-0 substate machine: request file → wait → wait sound → init. 4 substates",
    "0x02155bac": "update_running() — phase-1 dispatcher: touch handler → button or digit input → anim tick",
    "0x02155bf0": "update_exit_delay() — phase-2: decrements exit_delay counter, advances to teardown at 0",
    "0x02155c10": "update_teardown() — phase-3: registers scene-exit slot 10, invokes parent vtable slot 6",
    "0x02155c28": "draw_amount_row() — 396 bytes. Composes all on-screen numbers: 6 amount digits, 6 wallet digits, 6 bank digits, OK/CANCEL buttons, cursor highlight",
    "0x02155db4": "load_lzs_container() — starts async load of bank_in.lzs or bank_out.lzs based on mode byte",
    "0x02155e28": "bg_layer_alloc_uv_screen() — allocates BG layer 4 at 256×192, clears it",
    "0x02155e54": "bg_layer_free_uv_screen() — frees BG layer 4",
    "0x02155e6c": "set_bg0_palette_via_thunk() — palette setter trampoline through loader-patched function pointer",
    "0x02155e80": "init_bg_palette_zero_or_one() — palette setter trampoline (used by scene_draw_bg)",
    "0x02155e94": "init_bg_text_layer() — sets up BG text/icon overlays at top of bank screen. Glyph from loaded NCGR + sound-driven face animation",
    "0x02155efc": "init_sprites() — 304 bytes. Builds all 25 sprite handles from bank_in/bank_out NCGR/NCLR/NCER/NANR",
    "0x02156048": "release_sprites() — frees BG sprite + all 25 sprite handles. Called once at scene exit",
    "0x0215608c": "register_amount_arrow_oam() — registers 20 OAM hit regions: OK, CANCEL, 6 digit columns, 6 up arrows, 6 down arrows",
    "0x0215612c": "oam_register_helper_top() — forwarder to oam_register_object for top screen",
    "0x02156168": "oam_register_helper_bottom() — forwarder to oam_register_object for bottom screen",
    "0x021561a4": "release_oam_regions() — releases 20 OAM hit slots",
    "0x021561c0": "init_amount_clamps() — reads wallet/bank balances, computes max_amount with asymmetric caps",
    "0x0215620c": "commit_transaction() — the actual save-data write. Deposit: wallet -= amount, bank += amount. Withdraw: inverse",
    "0x02156254": "button_input_handler() — 368 bytes. DPad handler: START→OK, B→CANCEL, LEFT/RIGHT→cursor, UP/DOWN→digit nudge with auto-repeat",
    "0x021563d4": "digit_input_handler() — 382 bytes. Touch-mode handler: A→confirm, B→back, UP/DOWN→±1, LEFT/RIGHT→cycle OK/CANCEL",
    "0x02156560": "touch_handler() — 574 bytes. Polls OAM hit regions: OK/CANCEL buttons, 6 digit columns, 6 up arrows, 6 down arrows",
    "0x021567ac": "update_digit_cursor_anim() — drives per-digit highlight animation when cursor moves. Anim 10 = highlighted",
    "0x02156864": "update_digit_row() — 262 bytes. Clamps amount, updates wallet/bank display previews, renders all digit sprites",
    "0x0215696c": "update_digit_row_no_clamp() — sibling without top-clamp (used at init when amount is known-zero)",
    "0x02156a54": "anim_tick() — per-frame animation cooldown decrementer. Resets sprite anims after 6 frames",
    "0x02156a80": "scene_destroy_nop() [vtable 0] — no-op (BX LR)",
    "0x02156a84": "scene_free_heap() [vtable 1] — frees scene_ctx allocation via libc free",
}

# ── ov157 updates ──────────────────────────────────────────────────────────

OV157_UPDATES = {
    "purpose_summary": (
        "Dialogue renderer + rumor (uwasa) system — renders ALL on-screen text: "
        "dialog windows, onemsg floating bubbles, multi-choice prompts. Also "
        "contains the NPC rumor/reputation gameplay system. The bubble_sel byte "
        "in the init struct controls rendering: 0=WINDOW (260×138px dialog box), "
        "1-4=BUBBLE (128×76px floating). 251 total functions. Loads "
        "data/2d/selwindow/%s.lzs."
    ),
    "decode_status": "full",
    "decode_function_count": 251,
    "decode_note": (
        "251/251 functions decoded (247 Ghidra + 4 vtable-only). Contains "
        "the game's universal text renderer and the rumor (uwasa) NPC "
        "reputation system. Vtable at 0x021c33b4 (7 slots)."
    ),
    "translation_surface_summary": (
        "7 UTF-16 LE strings embedded. This overlay is the rendering ENGINE "
        "for all game dialog — it does not hold dialog text itself. Text comes "
        "from external OFS message files loaded by arm9's universal parser "
        "(FUN_02066c58)."
    ),
}

OV157_FUNC_HINTS = {
    "0x021b6080": "module_init() — overlay initialization entry point",
    "0x021b6180": "uwasa_toplevel_dispatcher() — top-level rumor system dispatcher",
    "0x021b62d8": "uwasa_state_machine_main() — 8-case main rumor-bubble state machine",
    "0x021b67bc": "uwasa_subflow_dispatch() — 5-case sub-state for sound + message progression",
    "0x021b6984": "uwasa_subflow_helper() — helper for rumor subflow transitions",
    "0x021b6a50": "select_window_state_machine() — 10-case choice-prompt UI state machine",
    "0x021b8030": "rumor_record_state() — 5-case per-rumor-record entry handler",
    "0x021b86e0": "npc_speaker_render_state() — 6-case NPC speaker animation + bubble render",
    "0x021b8dd0": "rumor_listen_dispatch() — 14-case largest sub-state-machine in overlay",
    "0x021b9f74": "rumor_pre_listen_setup() — 5-case pre-listen setup (NPC turn, camera, audio)",
    "0x021ba990": "uwasa_finalize_state() — 11-case finalization + save-buffer write",
    "0x021c0e3c": "dialogue_renderer_ctor() — allocates 660-byte (0x294) renderer instance",
    "0x021c0ef8": "dialogue_renderer_init_canonical() — canonical dialogue-render entry called from arm9 universal parser FUN_02066c58. param_4 = bubble_sel (0=WINDOW, 1-4=BUBBLE)",
    "0x021c0f48": "dialogue_renderer_init_method() [vtable 2] — populates instance from init-struct, calls layout pipeline",
    "0x021c115c": "dialogue_runtime_step() [vtable 3, HIDDEN] — per-frame 9-state machine on instance[+0x2d]",
    "0x021c144c": "dialogue_finalize_frame() [vtable 4, HIDDEN] — per-frame finalize/blit",
    "0x021c1104": "dialogue_destructor() [vtable 5, HIDDEN] — tears down renderer instance",
    "0x021c274c": "uwasa_uwp_play_audio() [vtable 1] — rumor audio playback",
    "0x021c2748": "vtable_noop() [vtable 0] — no-op stub",
}

# For ov157, bulk-rename generic hints
OV157_BULK_RENAME = {
    "code": "rumor/dialogue system helper",
    "high-fan-out (likely dispatcher / setup)": "state-machine dispatcher or complex handler",
    # "trampoline / small helper" stays as "utility trampoline"
}


def update_overlay(overlays_list, ov_id, field_updates, func_hints, bulk_rename=None):
    """Find an overlay by id, apply field and function-list updates."""
    ov = None
    for entry in overlays_list:
        if entry["id"] == ov_id:
            ov = entry
            break
    if ov is None:
        print(f"  ERROR: overlay id={ov_id} not found!")
        return 0

    # Apply top-level field updates
    for key, val in field_updates.items():
        old = ov.get(key, "<missing>")
        ov[key] = val
        if old != val:
            print(f"  ov{ov_id:03d}.{key}: updated")

    # Apply per-function role_hint updates
    func_by_addr = {f["addr"]: f for f in ov["function_list"]}
    updated_count = 0
    missing_addrs = []

    for addr, new_hint in func_hints.items():
        if addr in func_by_addr:
            old_hint = func_by_addr[addr]["role_hint"]
            func_by_addr[addr]["role_hint"] = new_hint
            updated_count += 1
        else:
            missing_addrs.append(addr)

    if missing_addrs:
        print(f"  WARNING: {len(missing_addrs)} addresses not found in function_list: {missing_addrs}")

    # Apply bulk renames for remaining generic hints (ov157 only)
    bulk_count = 0
    if bulk_rename:
        addressed_set = set(func_hints.keys())
        for func in ov["function_list"]:
            if func["addr"] in addressed_set:
                continue  # already handled by explicit hint
            old_hint = func["role_hint"]
            if old_hint in bulk_rename:
                func["role_hint"] = bulk_rename[old_hint]
                bulk_count += 1
            elif old_hint == "trampoline / small helper":
                func["role_hint"] = "utility trampoline"
                bulk_count += 1

    print(f"  ov{ov_id:03d}: {updated_count} explicit function hints applied, "
          f"{bulk_count} bulk-renamed, {len(missing_addrs)} missing")
    return updated_count + bulk_count


def main():
    print(f"Reading {OVERLAYS_JSON} ...")
    with open(OVERLAYS_JSON, "r", encoding="utf-8") as f:
        data = json.load(f)

    overlays = data["overlays"]
    print(f"Loaded {len(overlays)} overlays.\n")

    print("--- ov000 (Audition minigame) ---")
    update_overlay(overlays, 0, OV000_UPDATES, OV000_FUNC_HINTS)

    print("\n--- ov001 (Bank deposit/withdraw) ---")
    update_overlay(overlays, 1, OV001_UPDATES, OV001_FUNC_HINTS)

    print("\n--- ov157 (Dialogue renderer + uwasa) ---")
    update_overlay(overlays, 157, OV157_UPDATES, OV157_FUNC_HINTS, OV157_BULK_RENAME)

    print(f"\nWriting back to {OVERLAYS_JSON} ...")
    with open(OVERLAYS_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print("Done.")


if __name__ == "__main__":
    main()
