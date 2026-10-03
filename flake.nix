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
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ] (system:
      let
        pkgs = import nixpkgs { inherit system; };
        workspace = builtins.fromTOML (builtins.readFile ./cli-rs/Cargo.toml);

        wispctl = pkgs.rustPlatform.buildRustPackage {
          pname = "wispctl";
          version = workspace.workspace.package.version;
          src = ./cli-rs;
          cargoLock = {
            lockFile = ./cli-rs/Cargo.lock;
            # All git crates in Cargo.lock come from this same jacquard checkout.
            outputHashes = {
              "jacquard-0.13.0" = "sha256-1YCga3kKaG4IkMi1Xf+RJakzSdtgqI7RJWT1OFjuNuo=";
            };
          };
          cargoBuildFlags = [ "-p" "wispctl" ];
          cargoTestFlags = [ "--workspace" ];
          # Lower CI memory use; release binary packaging still uses fat LTO.
          CARGO_PROFILE_RELEASE_LTO = "thin";
          WISPCTL_NO_KEYCHAIN = "1";
          WISPCTL_NO_BROWSER = "1";
          SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
          meta = {
            description = "Deploy and serve static sites on wisp.place";
            mainProgram = "wispctl";
            license = pkgs.lib.licenses.mit;
          };
        };
      in
      {
        packages.default = wispctl;
        packages.wispctl = wispctl;
        checks.wispctl = wispctl;

        apps.default = {
          type = "app";
          program = "${wispctl}/bin/wispctl";
          meta.description = "Deploy and serve static sites on wisp.place";
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.cargo
            pkgs.rustc
            pkgs.clippy
            pkgs.rustfmt
            pkgs.bun
          ];
        };
      });
}
