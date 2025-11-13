{...}: {
  perSystem = {
    pkgs,
    config,
    lib,
    inputs',
    ...
  }: {
    # declare projects
    nci.projects."wisp-place-cli" = {
      path = ./cli;
      export = false;
    };
    nci.toolchains.mkBuild = _:
      with inputs'.fenix.packages;
        combine [
          minimal.rustc
          minimal.cargo
          targets.x86_64-pc-windows-gnu.latest.rust-std
          targets.x86_64-unknown-linux-gnu.latest.rust-std
          targets.aarch64-apple-darwin.latest.rust-std
          targets.aarch64-unknown-linux-gnu.latest.rust-std
        ];
    # configure crates
    nci.crates."wisp-cli" = {
      profiles = {
        dev.runTests = false;
        release.runTests = false;
      };
      targets."x86_64-unknown-linux-gnu" = let
        targetPkgs = pkgs.pkgsCross.gnu64;
        targetCC = targetPkgs.stdenv.cc;
        targetCargoEnvVarTarget = targetPkgs.stdenv.hostPlatform.rust.cargoEnvVarTarget;
      in rec {
        default = true;
        depsDrvConfig.mkDerivation = {
          nativeBuildInputs = [targetCC];
        };
        depsDrvConfig.env = rec {
          TARGET_CC = "${targetCC.targetPrefix}cc";
          "CARGO_TARGET_${targetCargoEnvVarTarget}_LINKER" = TARGET_CC;
        };
        drvConfig = depsDrvConfig;
      };
      targets."x86_64-pc-windows-gnu" = let
        targetPkgs = pkgs.pkgsCross.mingwW64;
        targetCC = targetPkgs.stdenv.cc;
        targetCargoEnvVarTarget = targetPkgs.stdenv.hostPlatform.rust.cargoEnvVarTarget;
      in rec {
        depsDrvConfig.mkDerivation = {
          nativeBuildInputs = [targetCC];
          buildInputs = with targetPkgs; [windows.pthreads];
        };
        depsDrvConfig.env = rec {
          TARGET_CC = "${targetCC.targetPrefix}cc";
          "CARGO_TARGET_${targetCargoEnvVarTarget}_LINKER" = TARGET_CC;
        };
        drvConfig = depsDrvConfig;
      };
      targets."aarch64-apple-darwin" = let
        targetPkgs = pkgs.pkgsCross.aarch64-darwin;
        targetCC = targetPkgs.stdenv.cc;
        targetCargoEnvVarTarget = targetPkgs.stdenv.hostPlatform.rust.cargoEnvVarTarget;
      in rec {
        depsDrvConfig.mkDerivation = {
          nativeBuildInputs = [targetCC];
        };
        depsDrvConfig.env = rec {
          TARGET_CC = "${targetCC.targetPrefix}cc";
          "CARGO_TARGET_${targetCargoEnvVarTarget}_LINKER" = TARGET_CC;
        };
        drvConfig = depsDrvConfig;
      };
      targets."aarch64-unknown-linux-gnu" = let
        targetPkgs = pkgs.pkgsCross.aarch64-multiplatform;
        targetCC = targetPkgs.stdenv.cc;
        targetCargoEnvVarTarget = targetPkgs.stdenv.hostPlatform.rust.cargoEnvVarTarget;
      in rec {
        depsDrvConfig.mkDerivation = {
          nativeBuildInputs = [targetCC];
        };
        depsDrvConfig.env = rec {
          TARGET_CC = "${targetCC.targetPrefix}cc";
          "CARGO_TARGET_${targetCargoEnvVarTarget}_LINKER" = TARGET_CC;
        };
        drvConfig = depsDrvConfig;
      };
    };
  };
}
