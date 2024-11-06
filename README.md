# DDNet Map Mirroring Script 地图镜像同步脚本

![Last Sync](https://ddnet-maps-1251829362.file.myqcloud.com/last-sync.svg) ![Sync Count](https://ddnet-maps-1251829362.file.myqcloud.com/sync-count.svg)

This is a script to download the official DDNet maps and uploading them to tencent object storage. We've moved the map mirroring script to Github Actions. The script will run twice a day.

这是针对大陆玩家的地图镜像同步脚本。该脚本会下载 DDNet 官方地图库并同步至腾讯云对象存储中。我们将地图镜像同步脚本转移到了 Github Actions 上。该脚本会每天运行两次。

## Usage 使用方法

Currently our mirror is officially supported by DDNet. If DDNet detected you are in China, it will automatically download maps from our mirror. Therefore, you do not need to do anything to benefit from our mirror.

目前我们的地图镜像为 DDNet 官方镜像。DDNet 客户端若检测到你的网络地区为中国大陆，则会自动从腾讯云的镜像中下载地图。因此你不需要进行任何配置。

## Report Issues 报告问题

Generally, the script will check the maps' hash and crc value to ensure they are valid before uploading to the mirror. However, in rare cases, there maybe invalid maps in the mirror, for example:

- The map is also corrupted in the official repository.
- One of our developers accidentally uploaded an invalid map during testing.
- The map is corrupted during uploading.

In such cases, you may experience map loading errors. If you have any problems regarding map downloading, feel free to [open an issue](https://github.com/TeeworldsCN/mirror-sync/issues/new) or join the [DDNet Discord](https://ddnet.org/discord) to let us know.

一般来说，脚本会检查地图的 hash 和 crc 值来确保地图数据是正常有效的。但是，在特定情况下，可能会导致损坏的地图被上传到镜像中，例如：

- 地图本身就是损坏的。
- 我们的开发者在测试过程中意外上传了损坏的地图。
- 地图在上传过程中发生了数据损坏问题。

在这种情况下，在下载地图时可能会出现报错问题。如果你对地图下载有任何问题，欢迎使用 [创建 Issue](https://github.com/TeeworldsCN/mirror-sync/issues/new) 或者加入 [DDNet Discord](https://ddnet.org/discord) 的方式与我们联系。
