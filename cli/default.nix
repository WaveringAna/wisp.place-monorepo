{rustPlatform}:
rustPlatform.buildRustPackage {
  name = "rust-cross-test";
  src = ./.;
  cargoLock.lockFile = ./Cargo.lock;
}
