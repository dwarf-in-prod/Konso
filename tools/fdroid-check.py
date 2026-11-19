#!/usr/bin/env python3
"""Replays the F-Droid build recipe (fdroid/app.konso.yml) on this repository, step by step, the
way F-Droid's build server does it, so a problem shows up on GitHub Actions before F-Droid sees it.
Used by the "F-Droid check" workflow (.github/workflows/fdroid-check.yml).

It relies on F-Droid's own tool, fdroidserver (pip install fdroidserver), for everything F-Droid
decides itself: reading the recipe, removing the signing keys, and the source and APK scanners.

Steps, in F-Droid's order (fdroidserver: common.prepare_source(), then build.build_local()):
  lint     RECIPE CONFIG      check the recipe with "fdroid lint", as fdroiddata's CI does
                              (CONFIG: the config/ folder of fdroiddata: categories and icons)
  sudo     RECIPE             run the recipe's "sudo" commands (install the Debian packages)
  prepare  RECIPE             delete the "rm" files, remove the signing keys, run "prebuild",
                              then scan the source: fails if the scanner finds a problem
  build    RECIPE             run the recipe's "build" commands (rebuild the vendored files)
  scan-apk APK                scan the built APK for non-free libraries and trackers
The gradle step itself (assembleRelease) is run by the workflow between "build" and "scan-apk".

Every command list runs as one "bash -e -u -o pipefail -x" script, its commands joined with "; ",
in the recipe's subdir: exactly like fdroidserver, so a command that works here works there.
Run it from the repository root (or pass --source DIR).
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import types

from fdroidserver import common, metadata, scanner


def last_build(recipe):
    """Reads the recipe with fdroidserver and returns its last build entry (the one F-Droid would
    build next), so every step uses exactly what F-Droid reads from the file."""
    common.config = common.config or {}
    app = metadata.parse_metadata(recipe)
    builds = app.get('Builds') or []
    if not builds:
        sys.exit('The recipe has no build entry.')
    return builds[-1]


def root_dir(source, build):
    """The folder F-Droid runs the recipe's commands in: the source, or its "subdir"."""
    return os.path.join(source, build.subdir) if build.subdir else source


def run_script(commands, cwd, sudo=False):
    """Runs a list of recipe commands like fdroidserver does: one bash script with -e -u
    -o pipefail -x, the commands joined with "; ", so a failing command stops the step."""
    if not commands:
        print('(nothing to run)')
        return
    script = '; '.join(commands)
    cmd = ['bash', '-e', '-u', '-o', 'pipefail', '-x', '-c', script]
    if sudo and os.geteuid() != 0:
        cmd = ['sudo', 'DEBIAN_FRONTEND=noninteractive'] + cmd
    elif sudo:
        cmd = ['env', 'DEBIAN_FRONTEND=noninteractive'] + cmd
    print('$ ' + script, flush=True)
    result = subprocess.run(cmd, cwd=cwd)
    if result.returncode != 0:
        sys.exit('Command failed with exit code %d' % result.returncode)


def gradle_version_code(source, build):
    """The versionCode written in the app's build.gradle, to compare with the recipe's."""
    path = os.path.join(root_dir(source, build), 'build.gradle')
    with open(path, encoding='utf-8') as f:
        for line in f:
            parts = line.split()
            if len(parts) == 2 and parts[0] == 'versionCode':
                return int(parts[1])
    return None


def print_categories(path):
    """Prints the category names F-Droid accepts (the top-level keys of fdroiddata's
    categories.yml), to help fix an invalid "Categories" entry."""
    names = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            if line[:1] not in ('', ' ', '\t', '#', '\n') and line.rstrip().endswith(':'):
                names.append(line.rstrip()[:-1].strip('"\''))
    print('Valid categories: ' + ', '.join(names))


def step_lint(args):
    """Checks the recipe with "fdroid lint" in a temporary copy of fdroiddata's layout
    (metadata/<app id>.yml next to fdroiddata's config/ folder, which holds the list of
    categories and their icons), so wrong fields, an unknown category or a badly formatted file
    are caught before the merge request to fdroiddata."""
    with tempfile.TemporaryDirectory() as tmp:
        os.makedirs(os.path.join(tmp, 'metadata'))
        shutil.copytree(args.config, os.path.join(tmp, 'config'))
        app_id = os.path.splitext(os.path.basename(args.recipe))[0]
        shutil.copy(args.recipe, os.path.join(tmp, 'metadata', app_id + '.yml'))
        fdroid = shutil.which('fdroid') or sys.exit('The fdroid command (fdroidserver) is missing.')
        result = subprocess.run([fdroid, 'lint', '-v', app_id], cwd=tmp)
        if result.returncode != 0:
            print_categories(os.path.join(args.config, 'categories.yml'))
            sys.exit('fdroid lint found problems in the recipe.')
    print('Recipe OK for fdroid lint.')


def step_sudo(args):
    """Runs the recipe's "sudo" commands, as root, like the build server does before anything else."""
    build = last_build(args.recipe)
    run_script(build.sudo, cwd=args.source, sudo=True)


def step_prepare(args):
    """Prepares the source like fdroidserver's prepare_source(): deletes the "rm" files, removes
    the signing keys from the gradle files, runs "prebuild", then runs F-Droid's source scanner,
    which must find nothing (no unknown binary, no non-free library)."""
    build = last_build(args.recipe)
    code = gradle_version_code(args.source, build)
    if code != build.versionCode:
        print('Note: the recipe builds versionCode %s, the source has %s.' % (build.versionCode, code))
    for part in build.rm:
        path = os.path.join(args.source, part)
        print('rm ' + part)
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path)
        elif os.path.lexists(path):
            os.remove(path)
        else:
            print('  ...but it did not exist')
    common.remove_signing_keys(args.source)
    run_script(build.prebuild, cwd=root_dir(args.source, build))
    scanner.options = types.SimpleNamespace(verbose=False, json=False, refresh_scanner=False)
    count = scanner.scan_source(args.source, build)
    if count > 0:
        sys.exit("F-Droid's source scanner found %d problem(s): see above." % count)
    print("F-Droid's source scanner found no problem.")


def step_build(args):
    """Runs the recipe's "build" commands, which rebuild the vendored files that "rm" deleted."""
    build = last_build(args.recipe)
    run_script(build.build, cwd=root_dir(args.source, build))


def step_scan_apk(args):
    """Scans the built APK with F-Droid's scanner (non-free libraries, trackers). It needs the
    Android SDK's dexdump, found through ANDROID_HOME."""
    sdk = os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT')
    if not sdk:
        sys.exit('ANDROID_HOME is not set: the APK scanner needs the Android SDK.')
    common.config = {'sdk_path': sdk}
    scanner.options = types.SimpleNamespace(verbose=False, json=False, refresh_scanner=False)
    count = scanner.scan_binary(args.apk)
    if count > 0:
        sys.exit("F-Droid's APK scanner found %d problem(s): see above." % count)
    print("F-Droid's APK scanner found no problem.")


def main():
    """Reads the command line and runs the requested step."""
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = parser.add_subparsers(dest='step', required=True)
    for name, func in [('sudo', step_sudo), ('prepare', step_prepare), ('build', step_build)]:
        p = sub.add_parser(name)
        p.add_argument('recipe')
        p.add_argument('--source', default='.')
        p.set_defaults(func=func)
    p = sub.add_parser('lint')
    p.add_argument('recipe')
    p.add_argument('config')
    p.set_defaults(func=step_lint)
    p = sub.add_parser('scan-apk')
    p.add_argument('apk')
    p.set_defaults(func=step_scan_apk)
    args = parser.parse_args()
    if hasattr(args, 'source'):
        args.source = os.path.abspath(args.source)
    if hasattr(args, 'recipe'):
        args.recipe = os.path.abspath(args.recipe)
    args.func(args)


if __name__ == '__main__':
    main()
