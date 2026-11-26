#!/usr/bin/env bash
# Cross-shell Tier A lifecycle driver for bash, zsh, and Git Bash.
# Runs all seven adapter lifecycle scenarios in a path containing spaces,
# using UTF-8 files (never inline JSON) and explicit exit-code capture.
set -eu

NODE_BIN="$1"
UTP_CLI="$2"
HELPER="$3"
WORKDIR="$4"
LOGFILE="$5"
SERVER_URL="$6"
CONTROL_URL="$7"
UNUSED_URL="$8"
VERIFIED_TOKEN="$9"
REMOTE_TOKEN="${10}"
SESSION_CLAUDE="${11}"
SESSION_CODEX="${12}"
SESSION_WRONG="${13}"
EXPIRES_AT="${14}"

FIX="$WORKDIR/fixtures with spaces"
REPO="$WORKDIR/repo with spaces"
HOME_MAIN="$WORKDIR/home main"
HOME_REMOTE="$WORKDIR/home remote"
OUT="$WORKDIR/last out.txt"
ERR="$WORKDIR/last err.txt"
mkdir -p "$FIX" "$REPO" "$HOME_MAIN" "$HOME_REMOTE"
: > "$LOGFILE"

# Initialize one disposable git checkout with spaces in its path.
git -C "$REPO" init -q
printf 'initial\n' > "$REPO/target.txt"
printf 'item-1\nitem-2\n' > "$REPO/pair.txt"

# Generate all UTF-8 JSON/text fixture files (with quotes, apostrophes, CRLF/LF, non-ASCII).
"$NODE_BIN" "$HELPER" write-fixtures "$FIX" "$EXPIRES_AT"

RC=0
run_utp() {
  set +e
  ( cd "$REPO" && "$NODE_BIN" "$UTP_CLI" "$@" ) > "$OUT" 2> "$ERR"
  RC=$?
  set -e
}

run_utp_stdin() {
  stdin_file="$1"
  shift
  set +e
  ( cd "$REPO" && "$NODE_BIN" "$UTP_CLI" "$@" < "$stdin_file" ) > "$OUT" 2> "$ERR"
  RC=$?
  set -e
}

jget() {
  "$NODE_BIN" "$HELPER" get "$OUT" "$1"
}

rec() {
  if [ -n "${4:-}" ]; then
    printf '{"scenario":"%s","step":"%s","code":%s,"detail":"%s"}\n' "$1" "$2" "$3" "$4" >> "$LOGFILE"
  else
    printf '{"scenario":"%s","step":"%s","code":%s}\n' "$1" "$2" "$3" >> "$LOGFILE"
  fi
}

has_text() {
  if grep -Fq "$2" "$1" 2>/dev/null; then
    printf 'yes'
  else
    printf 'no'
  fi
}

printf '%s\n' "$VERIFIED_TOKEN" > "$FIX/verified.tok"
printf '%s\n' "$REMOTE_TOKEN" > "$FIX/remote.tok"

export UTP_HOME="$HOME_MAIN"
export UTP_SESSION="session-a"
unset UTP_SERVER || true
unset UTP_PROJECT || true

run_utp_stdin "$FIX/verified.tok" connect "$SERVER_URL"
rec "setup" "connect-main" "$RC"
run_utp init --json
rec "setup" "init-main" "$RC"
PROJECT_ID="$(jget project)"

# Connect remote (unverifiable) home to same project.
export UTP_HOME="$HOME_REMOTE"
run_utp_stdin "$FIX/remote.tok" connect "$SERVER_URL"
rec "setup" "connect-remote" "$RC"
run_utp link "$PROJECT_ID" --json
rec "setup" "link-remote" "$RC"

export UTP_HOME="$HOME_MAIN"
export UTP_SESSION="session-a"

# ---------------------------------------------------------------------------
# Scenario 1: Full ask-to-applied, authority reuse, independent work & ordering
# ---------------------------------------------------------------------------
run_utp consider "$FIX/consider-routine.json" --json
rec "s1-lifecycle" "consider-routine" "$RC" "level=$(jget level)"

run_utp decide "$FIX/consider-routine.json" --json
rec "s1-lifecycle" "decide-routine" "$RC" "count=$(jget count)"

run_utp decide "$FIX/decide-choose.json" --json
rec "s1-lifecycle" "decide-choose" "$RC" "rev=$(jget revision)"
S1_ID="$(jget id)"

# Independent work completed before flushing.
printf 'independent work complete\n' > "$REPO/independent.txt"

run_utp flush --intent "$FIX/intent.json" --json
rec "s1-lifecycle" "flush" "$RC" "route=$(jget route)"
S1_REVIEW="$(jget review_id)"

run_utp wait "$S1_ID" --json
rec "s1-lifecycle" "wait-before-answer" "$RC" "status=$(jget status)"

run_utp presented "$S1_REVIEW" --channel conversation --json
rec "s1-lifecycle" "presented" "$RC"

run_utp answer "${S1_ID}@1" --option a --json
rec "s1-lifecycle" "answer" "$RC" "val=$(jget answer.value)"

"$NODE_BIN" "$HELPER" write-authority "$FIX/authority.json" "${S1_ID}@1"
run_utp consider "$FIX/authority.json" --json
rec "s1-lifecycle" "consider-authority" "$RC" "level=$(jget level)"

run_utp wait "${S1_ID}@1" --authority-file "$FIX/authority.json" --json
rec "s1-lifecycle" "wait-with-authority" "$RC" "status=$(jget status)"
S1_GRANT="$(jget grant.id)"

# Ordering guard: applied before begin must fail with exit 19.
run_utp applied "$S1_GRANT" --evidence "$FIX/evidence-auth.json" --json
rec "s1-lifecycle" "applied-before-begin" "$RC"

run_utp begin "$S1_GRANT" --json
rec "s1-lifecycle" "begin" "$RC"

printf 'applied-s1\n' > "$REPO/target.txt"
run_utp applied "$S1_GRANT" --evidence "$FIX/evidence-auth.json" --json
rec "s1-lifecycle" "applied" "$RC" "status=$(jget status)"

# ---------------------------------------------------------------------------
# Scenario 2: Clarification loop (exit 21 -> revise same request -> rev 2)
# ---------------------------------------------------------------------------
run_utp ask "$FIX/card-clarify.json" --json
rec "s2-clarify" "ask" "$RC" "rev=$(jget revision)"
S2_ID="$(jget id)"

run_utp flush --intent "$FIX/intent.json" --json
rec "s2-clarify" "flush-1" "$RC"
S2_REV1="$(jget review_id)"

run_utp presented "$S2_REV1" --channel conversation --json
rec "s2-clarify" "presented-1" "$RC"

run_utp answer "${S2_ID}@1" --clarify --file "$FIX/clarify-answer.json" --json
rec "s2-clarify" "request-clarify" "$RC"

run_utp wait "$S2_ID" --json
rec "s2-clarify" "wait-clarify" "$RC" "has_note=$(has_text "$OUT" "日本語")"

run_utp revise "$S2_ID" "$FIX/card-clarify-v2.json" --json
rec "s2-clarify" "revise" "$RC" "rev=$(jget revision)"

run_utp flush --intent "$FIX/intent.json" --json
rec "s2-clarify" "flush-2" "$RC"
S2_REV2="$(jget review_id)"

run_utp presented "$S2_REV2" --channel conversation --json
rec "s2-clarify" "presented-2" "$RC"

run_utp answer "${S2_ID}@2" --option a --json
rec "s2-clarify" "answer-v2" "$RC" "rev=$(jget revision)"

run_utp wait "$S2_ID" --json
rec "s2-clarify" "wait-v2" "$RC" "rev=$(jget revision)"
S2_GRANT="$(jget grant.id)"

run_utp begin "$S2_GRANT" --json
rec "s2-clarify" "begin" "$RC"

run_utp applied "$S2_GRANT" --evidence "$FIX/evidence-auth.json" --json
rec "s2-clarify" "applied" "$RC" "status=$(jget status)"

# ---------------------------------------------------------------------------
# Scenario 3: Level-2 eligible defaults & all D4 late-answer branches
# ---------------------------------------------------------------------------
# 3a: Clean default -> claim-default (15) -> begin -> applied
run_utp ask "$FIX/card-default.json" --json
S3A_ID="$(jget id)"
run_utp flush --json
S3A_REV="$(jget review_id)"
run_utp presented "$S3A_REV" --channel conversation --json
run_utp claim-default "$S3A_ID" --json
rec "s3a-default-clean" "claim-default" "$RC" "status=$(jget status)"
S3A_GRANT="$(jget grant.id)"
run_utp begin "$S3A_GRANT" --json
rec "s3a-default-clean" "begin" "$RC"
printf 'default-3a\n' > "$REPO/target.txt"
run_utp applied "$S3A_GRANT" --evidence "$FIX/evidence-auth.json" --json
rec "s3a-default-clean" "applied" "$RC" "status=$(jget status)"

# 3b-i: Late answer BEFORE claim-default -> claim-default exits 16
run_utp ask "$FIX/card-default.json" --json
S3B1_ID="$(jget id)"
run_utp flush --json
S3B1_REV="$(jget review_id)"
run_utp presented "$S3B1_REV" --channel conversation --json
run_utp answer "${S3B1_ID}@1" --option b --json
run_utp claim-default "$S3B1_ID" --json
rec "s3b-late-before-begin" "claim-after-answer" "$RC"
run_utp wait "$S3B1_ID" --json
rec "s3b-late-before-begin" "wait-after-16" "$RC" "val=$(jget answer.value)"
S3B1_GRANT="$(jget grant.id)"
run_utp begin "$S3B1_GRANT" --json
run_utp applied "$S3B1_GRANT" --evidence "$FIX/evidence-auth.json" --json
rec "s3b-late-before-begin" "applied-after-16" "$RC" "status=$(jget status)"

# 3b-ii: Late answer AFTER claim-default, BEFORE begin -> begin exits 17
run_utp ask "$FIX/card-default.json" --json
S3B2_ID="$(jget id)"
run_utp flush --json
S3B2_REV="$(jget review_id)"
run_utp presented "$S3B2_REV" --channel conversation --json
run_utp claim-default "$S3B2_ID" --json
rec "s3b-late-before-begin" "claim-default" "$RC"
S3B2_DEF_GRANT="$(jget grant.id)"
run_utp answer "${S3B2_ID}@1" --option b --json
run_utp begin "$S3B2_DEF_GRANT" --json
rec "s3b-late-before-begin" "begin-revoked" "$RC"
run_utp wait "$S3B2_ID" --json
rec "s3b-late-before-begin" "wait-new-grant" "$RC" "val=$(jget answer.value)"
S3B2_GRANT="$(jget grant.id)"
run_utp begin "$S3B2_GRANT" --json
rec "s3b-late-before-begin" "begin-answer-grant" "$RC"
run_utp applied "$S3B2_GRANT" --evidence "$FIX/evidence-auth.json" --json
rec "s3b-late-before-begin" "applied-answer-grant" "$RC" "status=$(jget status)"

# 3c: Late contradicting answer DURING executing -> applied exits 14
run_utp ask "$FIX/card-default.json" --json
S3C_ID="$(jget id)"
run_utp flush --json
S3C_REV="$(jget review_id)"
run_utp presented "$S3C_REV" --channel conversation --json
run_utp claim-default "$S3C_ID" --json
S3C_GRANT="$(jget grant.id)"
run_utp begin "$S3C_GRANT" --json
rec "s3c-late-during-exec" "begin" "$RC"
run_utp answer "${S3C_ID}@1" --option b --json
rec "s3c-late-during-exec" "answer-during-exec" "$RC"
printf 'default-3c\n' > "$REPO/target.txt"
run_utp applied "$S3C_GRANT" --evidence "$FIX/evidence-auth.json" --json
rec "s3c-late-during-exec" "applied-conflict" "$RC" "status=$(jget status)"
run_utp resolve-late "$S3C_ID" --resolution keep --json
rec "s3c-late-during-exec" "resolve-keep" "$RC" "status=$(jget status)"

# 3d-keep: Late contradicting answer AFTER applied -> wait 14 -> keep (no grant)
run_utp ask "$FIX/card-default.json" --json
S3DK_ID="$(jget id)"
run_utp flush --json
S3DK_REV="$(jget review_id)"
run_utp presented "$S3DK_REV" --channel conversation --json
run_utp claim-default "$S3DK_ID" --json
S3DK_GRANT="$(jget grant.id)"
run_utp begin "$S3DK_GRANT" --json
printf 'default-3dk\n' > "$REPO/target.txt"
run_utp applied "$S3DK_GRANT" --evidence "$FIX/evidence-auth.json" --json
run_utp answer "${S3DK_ID}@1" --option b --json
run_utp wait "$S3DK_ID" --json
rec "s3d-late-after-applied" "keep-wait-conflict" "$RC"
run_utp resolve-late "$S3DK_ID" --resolution keep --json
rec "s3d-late-after-applied" "resolve-keep" "$RC" "status=$(jget status);grant=$(jget grant.id)"

# 3d-redo: Late contradicting answer AFTER applied -> wait 14 -> redo (new grant) -> begin -> applied
run_utp ask "$FIX/card-default.json" --json
S3DR_ID="$(jget id)"
run_utp flush --json
S3DR_REV="$(jget review_id)"
run_utp presented "$S3DR_REV" --channel conversation --json
run_utp claim-default "$S3DR_ID" --json
S3DR_GRANT="$(jget grant.id)"
run_utp begin "$S3DR_GRANT" --json
printf 'default-3dr\n' > "$REPO/target.txt"
run_utp applied "$S3DR_GRANT" --evidence "$FIX/evidence-auth.json" --json
run_utp answer "${S3DR_ID}@1" --option b --json
run_utp wait "$S3DR_ID" --json
rec "s3d-late-after-applied" "redo-wait-conflict" "$RC"
run_utp resolve-late "$S3DR_ID" --resolution redo --json
rec "s3d-late-after-applied" "resolve-redo" "$RC" "opt=$(jget grant.option)"
S3DR_REDO_GRANT="$(jget grant.id)"
run_utp begin "$S3DR_REDO_GRANT" --json
rec "s3d-late-after-applied" "redo-begin" "$RC"
printf 'redo-3dr\n' > "$REPO/target.txt"
run_utp applied "$S3DR_REDO_GRANT" --evidence "$FIX/evidence-auth.json" --json
rec "s3d-late-after-applied" "redo-applied" "$RC" "status=$(jget status)"

# ---------------------------------------------------------------------------
# Scenario 4: Cancel, stale basis/rev, expiry, reconcile (not-performed/partial), release, takeover
# ---------------------------------------------------------------------------
# 4a: Cancel -> wait 12
run_utp ask "$FIX/card-clarify.json" --json
S4A_ID="$(jget id)"
run_utp flush --json
S4A_REV="$(jget review_id)"
run_utp presented "$S4A_REV" --channel conversation --json
run_utp cancel "$S4A_ID" --json
rec "s4-recovery" "cancel" "$RC" "status=$(jget status)"
run_utp wait "$S4A_ID" --json
rec "s4-recovery" "wait-cancelled" "$RC"

# 4b: Stale basis on begin (11) & stale old revision on answer (11)
run_utp ask "$FIX/card-clarify.json" --json
S4B_ID="$(jget id)"
run_utp flush --json
S4B_REV="$(jget review_id)"
run_utp presented "$S4B_REV" --channel conversation --json
run_utp answer "${S4B_ID}@1" --option a --json
run_utp wait "$S4B_ID" --json
S4B_GRANT="$(jget grant.id)"
printf 'changed-basis\n' > "$REPO/target.txt"
run_utp begin "$S4B_GRANT" --json
rec "s4-recovery" "stale-basis-begin" "$RC"
run_utp revise "$S4B_ID" "$FIX/card-clarify-v2.json" --json
run_utp answer "${S4B_ID}@1" --option a --json
rec "s4-recovery" "stale-rev-answer" "$RC"
run_utp cancel "$S4B_ID" --json

# 4c: Expiry -> wait 13
run_utp ask "$FIX/card-expire.json" --json
S4C_ID="$(jget id)"
run_utp flush --json
S4C_REV="$(jget review_id)"
run_utp presented "$S4C_REV" --channel conversation --json
"$NODE_BIN" "$HELPER" advance "$CONTROL_URL" 600000
run_utp wait "$S4C_ID" --json
rec "s4-recovery" "wait-expired" "$RC"

# 4d: release + lease expiry -> outcome_unknown -> reconcile not-performed -> re-grant
run_utp ask "$FIX/card-clarify.json" --json
S4D_ID="$(jget id)"
run_utp flush --json
S4D_REV="$(jget review_id)"
run_utp presented "$S4D_REV" --channel conversation --json
run_utp answer "${S4D_ID}@1" --option a --json
run_utp wait "$S4D_ID" --json
S4D_G1="$(jget grant.id)"
run_utp release "$S4D_G1" --json
rec "s4-recovery" "release" "$RC" "status=$(jget status)"
run_utp wait "$S4D_ID" --json
S4D_G2="$(jget grant.id)"
run_utp begin "$S4D_G2" --json
"$NODE_BIN" "$HELPER" advance "$CONTROL_URL" 90000000
run_utp wait "$S4D_ID" --json
rec "s4-recovery" "wait-outcome-unknown" "$RC"
run_utp reconcile "$S4D_G2" --outcome not-performed --evidence "$FIX/evidence-not-performed.json" --json
rec "s4-recovery" "reconcile-not-performed" "$RC" "status=$(jget status)"
run_utp wait "$S4D_ID" --json
S4D_G3="$(jget grant.id)"
run_utp begin "$S4D_G3" --json
run_utp applied "$S4D_G3" --evidence "$FIX/evidence-auth.json" --json
rec "s4-recovery" "applied-after-reconcile" "$RC" "status=$(jget status)"

# 4e: reconcile partial -> narrowed grant -> applied
run_utp ask "$FIX/card-partial.json" --json
S4E_ID="$(jget id)"
run_utp flush --json
S4E_REV="$(jget review_id)"
run_utp presented "$S4E_REV" --channel conversation --json
run_utp answer "${S4E_ID}@1" --option a --json
run_utp wait "$S4E_ID" --json
S4E_G1="$(jget grant.id)"
run_utp begin "$S4E_G1" --json
printf 'item-1-done\nitem-2\n' > "$REPO/pair.txt"
"$NODE_BIN" "$HELPER" advance "$CONTROL_URL" 90000000
run_utp reconcile "$S4E_G1" --outcome partial --evidence "$FIX/evidence-partial.json" --json
rec "s4-recovery" "reconcile-partial" "$RC" "status=$(jget status)"
run_utp wait "$S4E_ID" --json
rec "s4-recovery" "wait-partial-grant" "$RC" "scope=$(jget grant.authorization.scope)"
S4E_G2="$(jget grant.id)"
run_utp begin "$S4E_G2" --json
printf 'item-1-done\nitem-2-done\n' > "$REPO/pair.txt"
run_utp applied "$S4E_G2" --evidence "$FIX/evidence-partial-finish.json" --json
rec "s4-recovery" "applied-partial" "$RC" "status=$(jget status)"

# 4f: takeover after idle window + old owner epoch 31
export UTP_SESSION="session-a"
run_utp ask "$FIX/card-clarify.json" --json
S4F_ID="$(jget id)"
run_utp flush --json
S4F_REV="$(jget review_id)"
run_utp presented "$S4F_REV" --channel conversation --json
run_utp answer "${S4F_ID}@1" --option a --json
run_utp wait "$S4F_ID" --json
S4F_G1="$(jget grant.id)"
"$NODE_BIN" "$HELPER" advance "$CONTROL_URL" 1200000
export UTP_SESSION="session-b"
run_utp takeover "$S4F_ID" --json
rec "s4-recovery" "takeover" "$RC" "epoch=$(jget epoch)"
export UTP_SESSION="session-a"
run_utp begin "$S4F_G1" --json
rec "s4-recovery" "old-owner-begin-epoch" "$RC"
export UTP_SESSION="session-b"
run_utp wait "$S4F_ID" --json
S4F_G2="$(jget grant.id)"
run_utp begin "$S4F_G2" --json
run_utp applied "$S4F_G2" --evidence "$FIX/evidence-auth.json" --json
rec "s4-recovery" "new-owner-applied" "$RC" "status=$(jget status)"

# ---------------------------------------------------------------------------
# Scenario 5: Provenance & upfront level-3 routing matrix
# ---------------------------------------------------------------------------
printf 'Start release check.\n' > "$FIX/turn-start.txt"
printf 'yes\n' > "$FIX/turn-yes.txt"

for plat in claude codex; do
  if [ "$plat" = "claude" ]; then
    export UTP_SESSION="$SESSION_CLAUDE"
  else
    export UTP_SESSION="$SESSION_CODEX"
  fi
  export UTP_HOME="$HOME_MAIN"
  "$NODE_BIN" "$HELPER" transcript "$CONTROL_URL" "$plat" "$UTP_SESSION" "user" "$FIX/turn-start.txt"

  run_utp status --json
  rec "s5-provenance-$plat" "status-capability" "$RC" "chat=$(jget chat_provenance)"

  run_utp ask "$FIX/card-approve.json" --json
  S5_ID="$(jget id)"
  run_utp flush --intent "$FIX/intent.json" --json
  rec "s5-provenance-$plat" "flush-verified" "$RC" "route=$(jget route);chat=$(jget chat_provenance)"
  S5_REV="$(jget review_id)"

  run_utp show "$S5_REV"
  cp "$OUT" "$FIX/shown-$plat.md"
  "$NODE_BIN" "$HELPER" transcript "$CONTROL_URL" "$plat" "$UTP_SESSION" "assistant" "$FIX/shown-$plat.md"
  run_utp presented "$S5_REV" --channel conversation --json
  rec "s5-provenance-$plat" "presented" "$RC"
  S5_PRES="$(jget presentation_id)"

  "$NODE_BIN" "$HELPER" transcript "$CONTROL_URL" "$plat" "$UTP_SESSION" "user" "$FIX/turn-yes.txt"

  # 4 negative provenance cases
  run_utp answer "${S5_ID}@1" --from-chat --presentation "$S5_PRES" --quote-file "$FIX/quote-altered.txt" --json
  rec "s5-provenance-$plat" "neg-altered-quote" "$RC"

  run_utp answer "${S5_ID}@1" --from-chat --presentation "$S5_PRES" --quote-file "$FIX/quote-partial.txt" --json
  rec "s5-provenance-$plat" "neg-partial-quote" "$RC"

  SAVED_SID="$UTP_SESSION"
  export UTP_SESSION="$SESSION_WRONG"
  run_utp answer "${S5_ID}@1" --from-chat --presentation "$S5_PRES" --quote-file "$FIX/quote-exact.txt" --json
  rec "s5-provenance-$plat" "neg-wrong-session" "$RC"
  export UTP_SESSION="$SAVED_SID"

  run_utp answer "${S5_ID}@1" --from-chat --presentation "P-00000000-00000000" --quote-file "$FIX/quote-exact.txt" --json
  rec "s5-provenance-$plat" "neg-wrong-presentation" "$RC"

  # Positive match
  run_utp answer "${S5_ID}@1" --from-chat --presentation "$S5_PRES" --quote-file "$FIX/quote-exact.txt" --json
  rec "s5-provenance-$plat" "pos-chat-answer" "$RC" "verified=$(jget answer.verified)"

  run_utp wait "$S5_ID" --json
  rec "s5-provenance-$plat" "wait-transcript-grant" "$RC" "prov=$(jget grant.provenance)"
  S5_GRANT="$(jget grant.id)"
  run_utp begin "$S5_GRANT" --json
  run_utp applied "$S5_GRANT" --evidence "$FIX/evidence-approve.json" --json
  rec "s5-provenance-$plat" "applied" "$RC" "status=$(jget status)"

  # Reused quote check: new level-3 review presented AFTER earlier "yes", no new user turn
  run_utp ask "$FIX/card-approve.json" --json
  S5R_ID="$(jget id)"
  run_utp flush --intent "$FIX/intent.json" --json
  S5R_REV="$(jget review_id)"
  run_utp show "$S5R_REV"
  cp "$OUT" "$FIX/shown-reuse-$plat.md"
  "$NODE_BIN" "$HELPER" transcript "$CONTROL_URL" "$plat" "$UTP_SESSION" "assistant" "$FIX/shown-reuse-$plat.md"
  run_utp presented "$S5R_REV" --channel conversation --json
  S5R_PRES="$(jget presentation_id)"
  run_utp answer "${S5R_ID}@1" --from-chat --presentation "$S5R_PRES" --quote-file "$FIX/quote-exact.txt" --json
  rec "s5-provenance-$plat" "neg-reused-quote" "$RC"
  run_utp cancel "$S5R_ID" --json
done

# 5b: Unverifiable channel (Antigravity / remote host) -> upfront page routing + defensive 18
export UTP_HOME="$HOME_REMOTE"
export UTP_SESSION="agy-session-1"
run_utp status --json
rec "s5-unverifiable" "status-capability" "$RC" "chat=$(jget chat_provenance)"

run_utp ask "$FIX/card-approve.json" --json
S5U_ID="$(jget id)"
run_utp flush --intent "$FIX/intent.json" --json
S5U_REV="$(jget review_id)"
S5U_URL="$(jget url)"
rec "s5-unverifiable" "flush-upfront-page" "$RC" "route=$(jget route);chat=$(jget chat_provenance);has_url=$([ -n "$S5U_URL" ] && echo yes || echo no)"

# Verify human flush also prints page URL and never chat Markdown cards
run_utp ask "$FIX/card-approve.json" --json
S5U2_ID="$(jget id)"
run_utp flush --intent "$FIX/intent.json"
rec "s5-unverifiable" "flush-human-no-chat-md" "$RC" "has_md=$(has_text "$OUT" "### A.");has_hint=$(has_text "$OUT" "verified chat is unavailable")"
run_utp cancel "$S5U2_ID" --json

# Defensive exit 18: --from-chat fails without losing request/revision, then review page succeeds
run_utp presented "$S5U_REV" --channel conversation --json
S5U_PRES="$(jget presentation_id)"
run_utp answer "${S5U_ID}@1" --from-chat --presentation "$S5U_PRES" --quote-file "$FIX/quote-exact.txt" --json
rec "s5-unverifiable" "defensive-from-chat" "$RC"
run_utp show "$S5U_ID" --json
rec "s5-unverifiable" "preserved-after-18" "$RC" "status=$(jget request.status);rev=$(jget request.revision)"

PAGE_HTTP="$("$NODE_BIN" "$HELPER" browser-answer "$CONTROL_URL" "$S5U_URL" "yes")"
rec "s5-unverifiable" "page-answer" "0" "http=$PAGE_HTTP"
run_utp wait "$S5U_ID" --json
rec "s5-unverifiable" "wait-page-grant" "$RC" "prov=$(jget grant.provenance)"
S5U_GRANT="$(jget grant.id)"
run_utp begin "$S5U_GRANT" --json
run_utp applied "$S5U_GRANT" --evidence "$FIX/evidence-approve.json" --json
rec "s5-unverifiable" "applied-page" "$RC" "status=$(jget status)"

# ---------------------------------------------------------------------------
# Scenario 6: Separate-process exit & resume (same-session and new-session)
# ---------------------------------------------------------------------------
export UTP_HOME="$HOME_MAIN"
export UTP_SESSION="resume-session-1"
run_utp ask "$FIX/card-clarify.json" --json
S6A_ID="$(jget id)"
run_utp flush --intent "$FIX/intent.json" --json
S6A_REV="$(jget review_id)"
run_utp presented "$S6A_REV" --channel conversation --json
run_utp wait "$S6A_ID" --json
rec "s6-resume" "same-proc-a-blocks" "$RC"

# Process B (separate reviewer session) answers
export UTP_SESSION="reviewer-terminal"
run_utp answer "${S6A_ID}@1" --option a --json
rec "s6-resume" "same-proc-b-answers" "$RC"

# Process A2 resumes with SAME UTP_SESSION
export UTP_SESSION="resume-session-1"
run_utp status --json
rec "s6-resume" "same-proc-a2-status" "$RC"
run_utp wait "$S6A_ID" --json
rec "s6-resume" "same-proc-a2-wait" "$RC" "role=$(jget role)"
S6A_GRANT="$(jget grant.id)"
run_utp begin "$S6A_GRANT" --json
run_utp applied "$S6A_GRANT" --evidence "$FIX/evidence-auth.json" --json
rec "s6-resume" "same-proc-a2-applied" "$RC" "status=$(jget status)"

# New-session resume: Process A blocks & exits, Process B answers, Process C takes over
export UTP_SESSION="resume-session-old"
run_utp ask "$FIX/card-clarify.json" --json
S6B_ID="$(jget id)"
run_utp flush --intent "$FIX/intent.json" --json
S6B_REV="$(jget review_id)"
run_utp presented "$S6B_REV" --channel conversation --json
run_utp wait "$S6B_ID" --json
rec "s6-resume" "new-proc-a-blocks" "$RC"

export UTP_SESSION="reviewer-terminal"
run_utp answer "${S6B_ID}@1" --option a --json

export UTP_SESSION="resume-session-new"
run_utp takeover "$S6B_ID" --json
rec "s6-resume" "new-proc-c-takeover" "$RC" "epoch=$(jget epoch)"
run_utp wait "$S6B_ID" --json
rec "s6-resume" "new-proc-c-wait" "$RC" "role=$(jget role)"
S6B_GRANT="$(jget grant.id)"
run_utp begin "$S6B_GRANT" --json
run_utp applied "$S6B_GRANT" --evidence "$FIX/evidence-auth.json" --json
rec "s6-resume" "new-proc-c-applied" "$RC" "status=$(jget status)"

# ---------------------------------------------------------------------------
# Scenario 7: Unreachable service (32) & unset/"default" UTP_SESSION warning
# ---------------------------------------------------------------------------
export UTP_HOME="$HOME_MAIN"
export UTP_SESSION="session-healthy"
UTP_SERVER="$UNUSED_URL" run_utp status --json
rec "s7-guards" "unreachable-service" "$RC"

unset UTP_SESSION CODEX_THREAD_ID ANTIGRAVITY_CONVERSATION_ID
run_utp status --json
rec "s7-guards" "warn-unset-session" "$RC" "warn=$(has_text "$ERR" "UTP_SESSION is unset")"

export UTP_SESSION="default"
run_utp status --json
rec "s7-guards" "warn-default-session" "$RC" "warn=$(has_text "$ERR" "UTP_SESSION is unset")"

export UTP_SESSION="session-unique-ok"
run_utp status --json
rec "s7-guards" "quiet-valid-session" "$RC" "warn=$(has_text "$ERR" "UTP_SESSION is unset")"
