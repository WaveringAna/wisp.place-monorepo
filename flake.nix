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
      in {
        devShells.default = crateOutputs.devShell;
        packages.default = crateOutputs.packages.release;
        packages.wisp-cli-windows = crateOutputs.allTargets."x86_64-pc-windows-gnu".packages.release;
        packages.wisp-cli-darwin = crateOutputs.allTargets."aarch64-apple-darwin".packages.release;
      };
    };
}
