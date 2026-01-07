{
  inputs = {
    nixpkgs.url = "nixpkgs/nixos-unstable";
    rust-overlay.url = "github:oxalica/rust-overlay";
  };

  outputs = {
    self,
    nixpkgs,
    rust-overlay,
  }: let
    system = "aarch64-darwin";
    overlays = [(import rust-overlay)];
    pkgs = import nixpkgs {
      inherit overlays system;
      crossSystem = {
        config = "x86_64-unknown-linux-gnu";
        rustc.config = "x86_64-unknown-linux-gnu";
      };
    };
  in {
    packages.${system} = {
      default = self.outputs.packages.${system}.x86_64-linux-example;
      x86_64-linux-example = pkgs.callPackage ./. {};
    };
  };
}
