{
  description = "Public design documentation toolchain";

  inputs = {
    nixpkgs.url = "github:cachix/devenv-nixpkgs/rolling";
    meissa = {
      url = "github:RigelBuild/meissa/329ad720c1ed1ee7bd84cf6f27375405b8b1e823";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, meissa, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          meissaPackages = meissa.packages.${system};
        in {
          inherit (meissaPackages) rumdl biome;
          "rumdl-base-config" = meissaPackages."rumdl-base-config";
          bun = pkgs.bun;
        });
      devenvModules.default = meissa.devenvModules.default;
    };
}
