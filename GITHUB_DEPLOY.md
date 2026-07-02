# 推送到 GitHub 并一键安装

默认仓库：

```text
https://github.com/thepunk01/GCP.git
```

## 1. 本地推送

```bash
unzip -o gcp-compute-panel.zip
cd gcp-compute-panel
bash scripts/push_to_github.sh --force -m "add ops automation features"
```

## 2. 服务器一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/install.sh | sudo bash
```

安装完成后访问：

```text
http://服务器IP:8080
```

## 3. 服务器一键更新

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/GCP/main/scripts/update.sh | sudo bash
```

## 4. 新增能力

- 添加已开机服务器
- TCP / HTTP / HTTPS 检测
- 检测时间和失败阈值可调
- 绑定 GCP 实例后失败自动换 IP
- 绑定 GCP 实例后不可用自动创建替换实例
- SSH 预设命令下发
- 新建实例 startup script 预设

## 5. 私有仓库

如果仓库改成私有，服务器需要配置 GitHub Token 或 SSH Deploy Key，否则 `git clone` 会失败。
