{
  description = "wispctl, the wisp.place deployment and serving CLI";

  nixConfig = {
    extra-substituters = [
      "https://wispplace.cachix.org"
    ];
    extra-trusted-public-keys = [
      "wispplace.cachix.org-1:v+eZmUCZ9UGLyOCK4lFZvZKMCGCnBPOKDM+Q7ll1Jmw="
    ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    bun2nix.url = "github:nix-community/bun2nix";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, flake-utils, bun2nix }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ bun2nix.overlays.default ];
        };

        wispctl = pkgs.bun2nix.mkDerivation {
          pname = "wispctl";
          version = "1.1.3";
          src = ./.;
          postPatch = ''
            mv package.json package.json.root
            mv bun.lock bun.lock.root
          '';

          bunDeps = pkgs.bun2nix.fetchBunDeps {
            bunNix = ./cli/bun.nix;
          };

          bunInstallFlags = [
            "--frozen-lockfile"
            "--offline"
            "--linker=hoisted"
            "--backend=copyfile"
          ];
          postBunLifecycleScriptsPhase = ''
            ln -s "$PWD/node_modules" ../node_modules
          '';
          bunRoot = "cli";
          module = "index.ts";
          dontFixup = true;
          buildPhase = ''
            bun build ./cli/index.ts \
              --outfile wispctl \
              --compile \
              --minify \
              --sourcemap \
              --bytecode \
              --external @napi-rs/keyring \
              --external '@napi-rs/keyring-*'
          '';
          installPhase = ''
            install -Dm755 wispctl "$out/bin/wispctl"
          '';
          meta = {
            description = "Deploy and serve static sites on wisp.place";
            mainProgram = "wispctl";
          };
        };
      in
      {
        packages.default = wispctl;

        apps.default = {
          type = "app";
          program = "${wispctl}/bin/wispctl";
          meta = {
            description = "Deploy and serve static sites on wisp.place";
            mainProgram = "wispctl";
          };
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.bun2nix
          ];
        };
      });
}
