{
  description = "imp: Firecracker microVMs on your tailnet";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      # The imp host on NixOS (docs/guides/nixos.md).
      nixosModules.imp = ./deploy/nixos/module.nix;
      nixosModules.default = self.nixosModules.imp;

      checks.${system} = {
        eval = import ./deploy/nixos/tests/eval.nix { inherit nixpkgs pkgs self; };
        vm = import ./deploy/nixos/tests/vm.nix { inherit pkgs self; };
      };

      formatter.${system} = pkgs.nixfmt;
    };
}
