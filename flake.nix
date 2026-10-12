{
  description = "Public design documentation toolchain";

  inputs = {
    nixpkgs.url = "github:cachix/devenv-nixpkgs/rolling";
    # Not following nixpkgs: consumers share meissa's exact linter derivations.
    meissa.url = "github:RigelBuild/meissa/ced58ed79cccd0c2b25253f9812d070ef5bd31f1";
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
