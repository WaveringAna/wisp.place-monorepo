{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay.url = "github:oxalica/rust-overlay";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, rust-overlay, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit system overlays; };

        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          targets = [
            "x86_64-unknown-linux-musl"
            "aarch64-unknown-linux-musl"
            "x86_64-apple-darwin"
            "aarch64-apple-darwin"
          ];
        };

        cargoLockConfig = {
          lockFile = ./Cargo.lock;
          outputHashes = {
            "jacquard-0.9.5" = "sha256-75bas4VAYFcZAcBspSqS4vlJe8nmFn9ncTgeoT/OvnA=";
          };
        };

        # Native build for current system
        native = pkgs.rustPlatform.buildRustPackage {
          pname = "wisp-cli";
          version = "0.4.2";
          src = ./.;
          cargoLock = cargoLockConfig;
          nativeBuildInputs = [ rustToolchain ];
        };

        # Cross-compilation targets (Linux from macOS needs zigbuild)
        linuxTargets = let
          zigbuildPkgs = pkgs;
        in {
          x86_64-linux = pkgs.stdenv.mkDerivation {
            pname = "wisp-cli-x86_64-linux";
            version = "0.4.2";
            src = ./.;

            nativeBuildInputs = [
              rustToolchain
              pkgs.cargo-zigbuild
              pkgs.zig
            ];

            buildPhase = ''
              export HOME=$(mktemp -d)
              cargo zigbuild --release --target x86_64-unknown-linux-musl
            '';

            installPhase = ''
              mkdir -p $out/bin
              cp target/x86_64-unknown-linux-musl/release/wisp-cli $out/bin/
            '';

            # Skip Nix's cargo vendor - we use network
            dontConfigure = true;
            dontFixup = true;
          };

          aarch64-linux = pkgs.stdenv.mkDerivation {
            pname = "wisp-cli-aarch64-linux";
            version = "0.4.2";
            src = ./.;

            nativeBuildInputs = [
              rustToolchain
              pkgs.cargo-zigbuild
              pkgs.zig
            ];

            buildPhase = ''
              export HOME=$(mktemp -d)
              cargo zigbuild --release --target aarch64-unknown-linux-musl
            '';

            installPhase = ''
              mkdir -p $out/bin
              cp target/aarch64-unknown-linux-musl/release/wisp-cli $out/bin/
            '';

            dontConfigure = true;
            dontFixup = true;
          };
        };

      in {
        packages = {
          default = native;
          inherit native;

          # macOS universal binary
          macos-universal = pkgs.stdenv.mkDerivation {
            pname = "wisp-cli-macos-universal";
            version = "0.4.2";
            src = ./.;

            nativeBuildInputs = [ rustToolchain pkgs.darwin.lipo ];

            buildPhase = ''
              export HOME=$(mktemp -d)
              cargo build --release --target aarch64-apple-darwin
              cargo build --release --target x86_64-apple-darwin
            '';

            installPhase = ''
              mkdir -p $out/bin
              lipo -create \
                target/aarch64-apple-darwin/release/wisp-cli \
                target/x86_64-apple-darwin/release/wisp-cli \
                -output $out/bin/wisp-cli
            '';

            dontConfigure = true;
            dontFixup = true;
          };
        } // (if pkgs.stdenv.isDarwin then linuxTargets else {});

        devShells.default = pkgs.mkShell {
          buildInputs = [
            rustToolchain
            pkgs.cargo-zigbuild
            pkgs.zig
          ];
        };
      }
    );
}
