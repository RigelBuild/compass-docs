{ pkgs, ... }:
let
  flake = builtins.getFlake (toString ./.);
in
{
  imports = [ flake.devenvModules.default ];
  packages = [ pkgs.bun ];
}
