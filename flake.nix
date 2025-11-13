{
  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
  inputs.nci.url = "github:90-008/nix-cargo-integration";
  inputs.nci.inputs.nixpkgs.follows = "nixpkgs";
  inputs.parts.url = "github:hercules-ci/flake-parts";
  inputs.parts.inputs.nixpkgs-lib.follows = "nixpkgs";
  inputs.fenix = {
    url = "github:nix-community/fenix";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = inputs @ {
    parts,
    nci,
    ...
  }:
    parts.lib.mkFlake {inherit inputs;} {
      systems = ["x86_64-linux" "aarch64-darwin"];
      imports = [
        nci.flakeModule
        ./crates.nix
      ];
      perSystem = {
        pkgs,
        config,
        ...
      }: let
        crateOutputs = config.nci.outputs."wisp-cli";
        mkRenamedPackage = name: pkg: pkgs.runCommand name {} ''
          mkdir -p $out/bin
          cp ${pkg}/bin/wisp-cli $out/bin/${name}
        '';
      in {
        devShells.default = crateOutputs.devShell;
        packages.default = crateOutputs.packages.release;
        packages.wisp-cli-x86_64-linux = mkRenamedPackage "wisp-cli-x86_64-linux" crateOutputs.packages.release;
        packages.wisp-cli-aarch64-linux = mkRenamedPackage "wisp-cli-aarch64-linux" crateOutputs.allTargets."aarch64-unknown-linux-gnu".packages.release;
        packages.wisp-cli-x86_64-windows = mkRenamedPackage "wisp-cli-x86_64-windows.exe" crateOutputs.allTargets."x86_64-pc-windows-gnu".packages.release;
        packages.wisp-cli-aarch64-darwin = mkRenamedPackage "wisp-cli-aarch64-darwin" crateOutputs.allTargets."aarch64-apple-darwin".packages.release;
        packages.all = pkgs.symlinkJoin {
          name = "wisp-cli-all";
          paths = [
            config.packages.wisp-cli-x86_64-linux
            config.packages.wisp-cli-aarch64-linux
            config.packages.wisp-cli-x86_64-windows
            config.packages.wisp-cli-aarch64-darwin
          ];
        };
      };
    };
}
