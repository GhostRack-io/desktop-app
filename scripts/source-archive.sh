#!/usr/bin/env bash
# Validate ownership before reading repository settings or exporting tracked files.
source_archive() {
    local source=$1 expected_origin=$2 expected_revision=$3 output=$4 root gitdir configured attributes commit
    [[ ! -L $source/.git && -e $source/.git ]] || { printf 'Source must own its Git metadata.\n' >&2; return 1; }
    root=$(cd "$source" && pwd -P)
    [[ $(git -C "$source" rev-parse --show-toplevel) == "$root" ]] || return 1
    if [[ -f $source/.git ]]; then
        gitdir=$(git -C "$source" rev-parse --absolute-git-dir)
        configured=$(git -C "$source" config --get core.worktree) || return
        [[ $configured == /* ]] || configured=$gitdir/$configured
        [[ $(cd "$configured" && pwd -P) == "$root" ]] || return 1
    fi
    [[ $(git -C "$source" remote get-url origin) == "$expected_origin" ]] || { printf 'Source origin differs.\n' >&2; return 1; }
    commit=$(git -C "$source" rev-parse HEAD)
    [[ $commit =~ ^[0-9a-f]{40}$ && ( -z $expected_revision || $commit == "$expected_revision" ) ]] || return 1
    [[ -z $(git -C "$source" status --porcelain --untracked-files=all) ]] || { printf 'Source is dirty.\n' >&2; return 1; }
    attributes=$(git -C "$source" rev-parse --path-format=absolute --git-path info/attributes)
    [[ ! -s $attributes ]] || { printf 'Local archive attributes are unsupported.\n' >&2; return 1; }
    GIT_ATTR_NOSYSTEM=1 git -C "$source" -c core.attributesFile=/dev/null -c core.autocrlf=false -c core.eol=lf archive --format=tar "$commit" > "$output"
    printf '%s' "$commit"
}
