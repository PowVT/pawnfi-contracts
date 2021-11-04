/* eslint no-unused-vars: 0 */

import { ethers } from "hardhat";

import { LoanTerms } from "../test/utils/types";
import { createLoanTermsSignature } from "../test/utils/eip712";

import { main as deploy } from "./deploy";
import { main as redeploy } from "./redeploy-loancore";
import { deployNFTs, mintAndDistribute, SECTION_SEPARATOR } from "./bootstrap-tools";
import { ORIGINATOR_ROLE, REPAYER_ROLE } from "./constants";

export async function main(): Promise<void> {
    // Bootstrap five accounts only.
    // Skip the first account, since the
    // first signer will be the deployer.
    const [, ...signers] = (await ethers.getSigners()).slice(0, 6);

    console.log(SECTION_SEPARATOR);
    console.log("Deploying resources...\n");

    // Deploy the smart contracts
    const legacyContracts = await deploy();
    const { assetWrapper } = legacyContracts;
    const currentContracts = await redeploy(
        ORIGINATOR_ROLE,
        REPAYER_ROLE,
        assetWrapper.address,
        legacyContracts.feeController.address
    );

    const FlashRollover = await ethers.getContractFactory("FlashRollover");
    const flashRollover = await FlashRollover.deploy(
        "",
        currentContracts.loanCore.address,
        legacyContracts.loanCore.address,


    );
    await flashRollover.deployed();

    // Mint some NFTs
    console.log(SECTION_SEPARATOR);
    const { punks, art, beats, weth, pawnToken, usd } = await deployNFTs();

    // Distribute NFTs and ERC20s
    console.log(SECTION_SEPARATOR);
    console.log("Distributing assets...\n");
    await mintAndDistribute(signers, weth, pawnToken, usd, punks, art, beats);

    // Wrap some assets and create 2 bundles - one for legacy and one for new contract
    console.log(SECTION_SEPARATOR);
    console.log("Wrapping assets...\n");

    const signer1 = signers[1];
    const aw1 = await assetWrapper.connect(signer1);

    // Deposit 1 punk and 1000 usd for bundle 1
    await aw1.initializeBundle(signer1.address);
    const aw1Bundle1Id = await aw1.tokenOfOwnerByIndex(signer1.address, 0);
    const aw1Punk1Id = await punks.tokenOfOwnerByIndex(signer1.address, 0);

    await punks.connect(signer1).approve(aw1.address, aw1Punk1Id);
    await aw1.depositERC721(punks.address, aw1Punk1Id, aw1Bundle1Id);

    await usd.connect(signer1).approve(aw1.address, ethers.utils.parseUnits("1000", 6));
    await aw1.depositERC20(usd.address, ethers.utils.parseUnits("1000", 6), aw1Bundle1Id);
    console.log(`(Bundle 1) Signer ${signer1.address} created a bundle with 1 PawnFiPunk and 1000 PUSD`);

    // Deposit 1 punk and 2 beats edition 0 for bundle 2
    await aw1.initializeBundle(signer1.address);
    const aw1Bundle2Id = await aw1.tokenOfOwnerByIndex(signer1.address, 1);
    const aw1Punk2Id = await punks.tokenOfOwnerByIndex(signer1.address, 1);

    await punks.connect(signer1).approve(aw1.address, aw1Punk2Id);
    await aw1.depositERC721(punks.address, aw1Punk2Id, aw1Bundle2Id);

    await beats.connect(signer1).setApprovalForAll(aw1.address, true);
    await aw1.depositERC1155(beats.address, 0, 2, aw1Bundle2Id);
    console.log(`(Bundle 2) Signer ${signer1.address} created a bundle with 1 PawnFiPunk ands 2 PawnBeats Edition 0`);

    console.log(SECTION_SEPARATOR);
    console.log("Initializing loan with old LoanCore...\n");

    // Start some loans
    const signer2 = signers[2];
    const oneDayMs = 1000 * 60 * 60 * 24;
    const oneWeekMs = oneDayMs * 7;

    const relSecondsFromMs = (msToAdd: number) => Math.floor(msToAdd / 1000);

    // 1 will borrow from 2
    const loan1Terms: LoanTerms = {
        durationSecs: relSecondsFromMs(oneWeekMs),
        principal: ethers.utils.parseEther("10"),
        interest: ethers.utils.parseEther("1.5"),
        collateralTokenId: aw1Bundle1Id,
        payableCurrency: weth.address,
    };

    const {
        v: loan1V,
        r: loan1R,
        s: loan1S,
    } = await createLoanTermsSignature(legacyContracts.originationController.address, "OriginationController", loan1Terms, signer1);

    await weth.connect(signer2).approve(legacyContracts.originationController.address, ethers.utils.parseEther("10"));
    await assetWrapper.connect(signer1).approve(legacyContracts.originationController.address, aw1Bundle1Id);

    // Borrower signed, so lender will initialize
    await legacyContracts.originationController
        .connect(signer2)
        .initializeLoan(loan1Terms, signer1.address, signer2.address, loan1V, loan1R, loan1S);

    console.log(
        `(Loan 1) Signer ${signer1.address} borrowed 10 WETH at 15% interest from ${signer2.address} against Bundle 1 using LoanCore at ${legacyContracts.loanCore.address}`,
    );

    console.log(SECTION_SEPARATOR);
    console.log("Initializing loan with new LoanCore...\n");

    const signer3 = signers[3];

    const loan2Terms: LoanTerms = {
        durationSecs: relSecondsFromMs(oneWeekMs) - 10,
        principal: ethers.utils.parseEther("10000"),
        interest: ethers.utils.parseEther("500"),
        collateralTokenId: aw1Bundle2Id,
        payableCurrency: pawnToken.address,
    };

    const {
        v: loan2V,
        r: loan2R,
        s: loan2S,
    } = await createLoanTermsSignature(currentContracts.originationController.address, "OriginationController", loan2Terms, signer1);

    await pawnToken.connect(signer3).approve(currentContracts.originationController.address, ethers.utils.parseEther("10000"));
    await assetWrapper.connect(signer1).approve(currentContracts.originationController.address, aw1Bundle2Id);

    // Borrower signed, so lender will initialize
    await currentContracts.originationController
        .connect(signer3)
        .initializeLoan(loan2Terms, signer1.address, signer3.address, loan2V, loan2R, loan2S);

    console.log(
        `(Loan 2) Signer ${signer1.address} borrowed 10000 PAWN at 5% interest from ${signer3.address} against Bundle 2 using LoanCore at ${currentContracts.loanCore.address}`,
    );

    // Roll over both loans
    console.log(SECTION_SEPARATOR);
    console.log("Rolling over old loan...\n");

}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((error: Error) => {
            console.error(error);
            process.exit(1);
        });
}
