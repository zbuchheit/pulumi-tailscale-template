import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as fs from "fs";
import * as tailscale from "@pulumi/tailscale";
import * as cloudinit from "@pulumi/cloudinit";

const tailScaleConfig = new pulumi.Config("tailscale");
tailScaleConfig.requireSecret("apiKey"); // Required for the provider

const config = new pulumi.Config();
const vpcCIDRBlock = config.get("vpcCIDRBlock") || "10.0.0.0/16";
const privateSubnetCIDR = config.get("privateSubnetCIDR") || "10.0.1.0/24";
const publicSubnetCIDR = config.get("publicSubnetCIDR") || "10.0.99.0/24";
const tailscaleHostname = config.get("hostname") || pulumi.getProject();
const tailscaleSSH = config.getBoolean("tailscaleSSHEnabled") || true;

const tailscaleAuthKey = new tailscale.TailnetKey("tailnet-auth-key", {
    description: pulumi.getProject(),
    ephemeral: true,
    preauthorized: true,
    recreateIfInvalid: "always",
    reusable: true,
});

const vpc = new awsx.ec2.Vpc(`${pulumi.getProject()}-vpc`, {
    cidrBlock: vpcCIDRBlock,
    numberOfAvailabilityZones: 1,
    subnetStrategy: awsx.ec2.SubnetAllocationStrategy.Auto,
    subnetSpecs: [
        {
            name: `${pulumi.getProject()}-public`, type: "Public", cidrBlocks: [publicSubnetCIDR]

        },
        {
            name: `${pulumi.getProject()}-private`, type: "Private", cidrBlocks: [privateSubnetCIDR]
        }
    ],
    enableDnsHostnames: true,
    enableDnsSupport: true,
});

const amazonLinux = aws.ec2.getAmiOutput({
    owners: ["amazon"],
    mostRecent: true,
    filters: [
        {
            name: "architecture",
            values: ["arm64"],
        },
        {
            name: "name",
            values: ["ubuntu/images/*ubuntu-noble-24.04-*"],
        },
        {
            name: "virtualization-type",
            values: ["hvm"],
        }
    ],
});

const substitutedYaml: pulumi.Output<string> = tailscaleAuthKey.key.apply(key => {
    return fs.readFileSync("./scripts/tailscale-up.yaml", "utf8")
    .replace("TAILSCALE_AUTH_KEY", key)
    .replace("TAILSCALE_HOSTNAME", tailscaleHostname)
    .replace("TAILSCALE_SSH", tailscaleSSH.toString())
})

const cloudInitUserData = cloudinit.getConfigOutput({
    gzip: false,
    base64Encode: false,
    parts: [
        {
            contentType: "text/cloud-config",
            filename: "tailscale-install.yaml",
            content: fs.readFileSync("./scripts/tailscale-install.yaml", "utf8"),
        },
        {
            contentType: "text/cloud-config",
            filename: "tailscale-up.yaml",
            content: substitutedYaml,
        }
    ]
})

new aws.ec2.Instance("tailscale-node", {
    subnetId: vpc.privateSubnetIds[0],
    instanceType: "t4g.nano",
    ami: amazonLinux.id,
    userData: cloudInitUserData.rendered,
    tags: {
        Name: tailscaleHostname,
    },
}, {
    replaceOnChanges: [
        "userData"
    ]
})


export const connectionString = pulumi.interpolate`ssh ubuntu@${tailscaleHostname}`