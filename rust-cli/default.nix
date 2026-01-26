{
  rustPlatform,
  glibc,
}:
rustPlatform.buildRustPackage {
  name = "wisp-cli";
  src = ./.;
  cargoLock = {
    lockFile = ./Cargo.lock;
    outputHashes = {
      "jacquard-0.9.5" = "sha256-75bas4VAYFcZAcBspSqS4vlJe8nmFn9ncTgeoT/OvnA=";
    };
  };
  buildInputs = [glibc.static];
  RUSTFLAGS = ["-C" "target-feature=+crt-static"];
}
