{
  description = "isopod CLI and source-only Offload assets";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      lib = nixpkgs.lib;

      nodejs = pkgs.nodejs_22;

      cleanNodeFilter = path: type:
        let
          name = baseNameOf (toString path);
        in
        lib.cleanSourceFilter path type
        && !(builtins.elem name [ "node_modules" "dist" "clone" ".DS_Store" ])
        && !(lib.hasPrefix ".env" name);

      apiSource = lib.cleanSourceWith {
        src = ./api;
        filter = cleanNodeFilter;
      };

      repoRoot = toString ./.;
      cliSource = lib.cleanSourceWith {
        src = ./.;
        filter = path: type:
          let
            relativePath = lib.removePrefix "${repoRoot}/" (toString path);
            allowed =
              relativePath == "cli"
              || lib.hasPrefix "cli/" relativePath
              || builtins.elem relativePath [
                "api"
                "api/package.json"
                "api/package-lock.json"
                "api/bin"
                "api/bin/clone.c"
                "api/scripts"
                "api/scripts/build-clone-helper.mjs"
              ];
          in
          allowed && cleanNodeFilter path type;
      };

      offloadAssetSource = lib.cleanSourceWith {
        src = ./docker/offload;
        filter = lib.cleanSourceFilter;
      };

      offloadBaseImage = pkgs.dockerTools.buildLayeredImage {
        name = "isopod-offload-source-only";
        tag = "1";
        contents = with pkgs; [
          bash
          busybox
          cacert
          coreutils
          findutils
          gawk
          git
          gnugrep
          gnused
          openssh
          procps
        ];
        extraCommands = ''
          mkdir -p workspace home/dev tmp
          chmod 1777 tmp
        '';
        config = {
          Cmd = [
            "/bin/sh"
            "-lc"
            "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done"
          ];
          WorkingDir = "/workspace";
          Env = [
            "HOME=/home/dev"
            "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
            "GIT_SSL_CAINFO=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
          ];
          Labels = {
            "isopod.managed" = "true";
            "isopod.backend" = "offload";
            "isopod.profile" = "source-only";
            "isopod.schema" = "1";
          };
        };
      };

      apiPackage = pkgs.buildNpmPackage {
        pname = "isopod-api";
        version = "1.0.0";
        src = apiSource;
        inherit nodejs;
        npmDepsHash = "sha256-EZSYwVzmy6u2TmWi5eq13gWC6VhF9v1tzA8xjmcqzwA=";
        npmBuildScript = "build";
        npmDepsFetcherVersion = 2;
        npmFlags = [ "--legacy-peer-deps" ];
        doCheck = true;

        preBuild = ''
          node scripts/build-clone-helper.mjs
        '';

        checkPhase = ''
          runHook preCheck
          npm test
          runHook postCheck
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/lib/isopod-api"
          cp -R dist package.json bin node_modules "$out/lib/isopod-api/"
          runHook postInstall
        '';
      };

      cliPackage = pkgs.buildNpmPackage {
        pname = "isopod-cli";
        version = "1.0.0";
        src = cliSource;
        sourceRoot = "source/cli";
        inherit nodejs;
        npmDepsHash = "sha256-Wcr5LV6o17mYnVAX0D07AV6SfNTmL7rM/3Tbc+Nw/ss=";
        npmBuildScript = "build";
        npmDepsFetcherVersion = 2;
        npmRebuildFlags = [ "--ignore-scripts" ];
        doCheck = true;

        preBuild = ''
          rm -rf node_modules/isopod-api
          cp -R --no-preserve=mode,ownership \
            ${apiPackage}/lib/isopod-api \
            node_modules/isopod-api
        '';

        checkPhase = ''
          runHook preCheck
          node --test test/offload.test.mjs
          runHook postCheck
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/lib/isopod-cli"
          cp -R dist package.json node_modules "$out/lib/isopod-cli/"
          runHook postInstall
        '';
      };

      isopod = pkgs.stdenvNoCC.mkDerivation {
        pname = "isopod";
        version = "1.0.0";
        src = offloadAssetSource;
        dontBuild = true;
        nativeBuildInputs = [ pkgs.makeWrapper ];

        installPhase = ''
          runHook preInstall

          mkdir -p \
            "$out/bin" \
            "$out/lib/isopod" \
            "$out/lib/isopod/docker/offload" \
            "$out/lib/isopod/images"
          cp -R ${apiPackage}/lib/isopod-api "$out/lib/isopod/api"
          cp -R ${cliPackage}/lib/isopod-cli "$out/lib/isopod/cli"

          chmod u+w "$out/lib/isopod/cli/node_modules"
          chmod -R u+w "$out/lib/isopod/cli/node_modules/isopod-api"
          rm -rf "$out/lib/isopod/cli/node_modules/isopod-api"
          ln -s ../../api "$out/lib/isopod/cli/node_modules/isopod-api"

          cp workspace.Dockerfile "$out/lib/isopod/docker/offload/workspace.Dockerfile"
          ln -s ${offloadBaseImage} "$out/lib/isopod/images/isopod-offload-source-only.tar"
          printf 'isopod-offload-source-only:1\n' > "$out/lib/isopod/images/isopod-offload-source-only.name"

          makeWrapper ${nodejs}/bin/node "$out/bin/isopod" \
            --add-flags "$out/lib/isopod/cli/dist/index.js"

          runHook postInstall
        '';

        meta = {
          description = "isopod CLI with source-only Offload assets";
          platforms = [ system ];
        };
      };
    in
    {
      packages.${system} = {
        inherit isopod;
        default = isopod;
        api = apiPackage;
        cli = cliPackage;
        offload-base-image = offloadBaseImage;
      };
    };
}
