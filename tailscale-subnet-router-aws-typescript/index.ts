import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as fs from "fs";
import * as tailscale from "@pulumi/tailscale";
import { TailscaleComponent } from "./components/tailscale-component";
import { NetworkComponent } from "./components/network-component";
import { getUbuntuLinuxAmi } from "./utils/utils";

const config = new pulumi.Config();
const vpcCidrBlock = config.get("vpcCidrBlock") || "10.0.0.0/16";
const privateSubnetCidrs = config.get("privateSubnetCidrs") || "10.0.1.0/24";
const publicSubnetCidrs = config.get("publicSubnetCidrs") || "10.0.101.0/24";
const privateInstanceIP = config.get("privateInstanceIP") || "10.0.1.25";

const project = pulumi.getProject();

const tailscaleConfig = new pulumi.Config("tailscale");
tailscaleConfig.require("tailnet");

const tailscaleACL = new tailscale.Acl("tailnet-acl", {
  acl: fs.readFileSync("./acl.hujson", {encoding: "utf8"}),
  overwriteExistingContent: config.requireBoolean("overwriteExistingACL"), // Doing this to force you to be explicit about overwriting existing ACLs
});

const oauthClient = new tailscale.OauthClient(`${project}-oauth-client`, {
  scopes: ["auth_keys"],
  description: `Managed by Pulumi Project-${project}`,
  tags: ["tag:parent-tag"], // Parent Tag which owns all sub-tags
});

const networkComponent = new NetworkComponent(`${project}-network`, {
  vpcCidrBlock: vpcCidrBlock,
  publicSubnetCidrs: [publicSubnetCidrs],
  privateSubnetCidrs: [privateSubnetCidrs],
  numberOfAvailabilityZones: 1,
});

const tailscaleOAuthKeyString: pulumi.Output<string> = pulumi.interpolate`${oauthClient.key}?ephemeral=true&preauthorized=true`;

const subnetRouter = new TailscaleComponent(
  `${project}-subnet-router`,
  {
    ami: getUbuntuLinuxAmi().id,
    vpcSecurityGroupIds: [networkComponent.publicSecurityGroup.id],
    subnetId: networkComponent.vpc.privateSubnetIds[0],
    instanceType: "t4g.small", // Not recommended for production, see https://tailscale.com/kb/1296/aws-reference-architecture#recommended-instance-sizing
    tailscaleArgs: {
      authKey: tailscaleOAuthKeyString,
      ssh: true,
      advertiseRoutes: [vpcCidrBlock],
      advertiseTags: [`tag:subnet-router`],
    },
  },
  {
    dependsOn: [tailscaleACL],
  },
);

const privateInstance = new aws.ec2.Instance(
  `${project}-private-instance`,
  {
    subnetId: networkComponent.vpc.privateSubnetIds[0],
    instanceType: "t4g.nano",
    vpcSecurityGroupIds: [networkComponent.privateSecurityGroup.id],
    ami: getUbuntuLinuxAmi().id,
    privateIp: privateInstanceIP,
  },
  {
    replaceOnChanges: ["userData"],
    deleteBeforeReplace: true,
  },
);

export const command = pulumi.interpolate`tailscale ping ${privateInstance.privateIp}`;