{
  description = "wisp-cli - Static site hosting CLI for AT Protocol";

  # === INPUTS ===
  # These are the dependencies of your flake (like package.json dependencies)
  inputs = {
    # nixpkgs is the main Nix package repository
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # rust-overlay gives us easy access to Rust toolchains with cross-compilation targets
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # flake-utils provides helpers for multi-system flakes
    flake-utils.url = "github:numtide/flake-utils";
  };

  # === OUTPUTS ===
  outputs = { self, nixpkgs, rust-overlay, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit system overlays; };

        # Rust toolchain with cross-compilation targets
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          targets = [
            "x86_64-unknown-linux-musl"
            "aarch64-unknown-linux-musl"
            "x86_64-apple-darwin"
            "aarch64-apple-darwin"
          ];
        };

        version = "0.5.0";
        pname = "wisp-cli";


        # Linux cross-compilation (uses zig as linker for musl)
        mkLinuxPackage = { target, suffix }: pkgs.stdenv.mkDerivation {
          pname = "${pname}-${suffix}";
          inherit version;
          src = ./cli;

          nativeBuildInputs = [
            rustToolchain
            pkgs.cargo-zigbuild
            pkgs.zig
            pkgs.cacert
          ];

          __noChroot = true;

          buildPhase = ''
            export HOME=$(mktemp -d)
            export CARGO_HOME=$(mktemp -d)
            export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
            export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_RUSTFLAGS="-C target-feature=+crt-static"
            export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS="-C target-feature=+crt-static"
            cargo zigbuild --release --target ${target}
          '';

          installPhase = ''
            mkdir -p $out/bin
            cp target/${target}/release/${pname} $out/bin/${pname}
          '';

          dontConfigure = true;
          dontFixup = true;
        };

        # macOS builds (native cargo)
        mkDarwinPackage = { target, suffix }: pkgs.stdenv.mkDerivation {
          pname = "${pname}-${suffix}";
          inherit version;
          src = ./cli;

          nativeBuildInputs = [ rustToolchain pkgs.cacert ];

          __noChroot = true;

          buildPhase = ''
            export HOME=$(mktemp -d)
            export CARGO_HOME=$(mktemp -d)
            export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
            cargo build --release --target ${target}
          '';

          installPhase = ''
            mkdir -p $out/bin
            cp target/${target}/release/${pname} $out/bin/${pname}
          '';

          dontConfigure = true;
          dontFixup = true;
        };

        # Cross-compiled packages
        linux-x86_64 = mkLinuxPackage {
          target = "x86_64-unknown-linux-musl";
          suffix = "linux-x86_64";
        };

        linux-aarch64 = mkLinuxPackage {
          target = "aarch64-unknown-linux-musl";
          suffix = "linux-aarch64";
        };

        macos-x86_64 = mkDarwinPackage {
          target = "x86_64-apple-darwin";
          suffix = "macos-x86_64";
        };

        macos-aarch64 = mkDarwinPackage {
          target = "aarch64-apple-darwin";
          suffix = "macos-aarch64";
        };

        # Build all targets and collect binaries
        all = pkgs.stdenv.mkDerivation {
          pname = "${pname}-all";
          inherit version;
          dontUnpack = true;

          installPhase = ''
            mkdir -p $out
            cp ${linux-x86_64}/bin/${pname} $out/${pname}-linux-x86_64
            cp ${linux-aarch64}/bin/${pname} $out/${pname}-linux-aarch64
            cp ${macos-x86_64}/bin/${pname} $out/${pname}-macos-x86_64
            cp ${macos-aarch64}/bin/${pname} $out/${pname}-macos-aarch64
          '';
        };

        # Pick the right default based on current system
        default = {
          "x86_64-linux" = linux-x86_64;
          "aarch64-linux" = linux-aarch64;
          "x86_64-darwin" = macos-x86_64;
          "aarch64-darwin" = macos-aarch64;
        }.${system};

      in {
        packages = {
          inherit default linux-x86_64 linux-aarch64 macos-x86_64 macos-aarch64 all;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [
            rustToolchain
            pkgs.cargo-zigbuild
            pkgs.zig
            pkgs.rust-analyzer
          ];
          # Darwin stdenv includes SDK with frameworks and libiconv automatically
        };
      }
    );
}
