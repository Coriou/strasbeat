export default `setcpm(200/3)

const A = "d4@2 d4 d4@2 d4"
const B = "d4@2 d4 d4 d4 d4"
const C = "d4@2 d4 d4 a3 c4"
const D = "[f3,a3,d4]@2 [f3,a3,d4]@2 [f3,a3,d4] [a3,c4,e4]"
const E = "[a#3,d4,f4]@2 [a#3,d4,f4]@2 [a#3,d4,f4] [d4,g4]"
const F = "[a3,c4,e4]@2 [a3,c4,e4]@2 [a3,d4] [g3,c4]"
const G = "[a3,c4] [a3,d4]@2 ~ a3 c4"
const H = "[f3,a#3,d4]@2 [f3,a#3,d4]@2 [a#3,d4] [a#3,e4]"
const I = "[a3,c4,f4]@2 [a3,c4,f4]@2 [c4,f4] [c4,g4]"
const J = "[f3,a3,d4]@2 ~@2 a3 c4"
const K = "[f3,a3,d4]@2 [f3,a3,d4]@2 [a3,d4] [a3,f4]"
const L = "[a#3,d4,g4]@2 [a#3,d4,g4]@2 [d4,g4] [d4,a4]"
const M = "[d4,g4,a#4]@2 [d4,g4,a#4]@2 [f4,a4] [e4,g4]"
const N = "[f4,a4] d4@2 ~ d4 e4"
const O = "[a#3,d4,f4]@2 [a#3,d4,f4]@2 [a#3,d4,g4]@2"
const P = "[f4,a4] d4@2 ~ d4 f4"
const Q = "[a3,c#4,e4]@2 [a3,c#4,e4]@2 [d4,f4] [b3,d4]"
const R = "[a3,c#4,e4]@3 ~ a4 c5"
const S = "[f4,a4,d5]@2 [f4,a4,d5]@2 [f4,a4,d5] [a4,c5,e5]"
const T = "[a#4,d5,f5]@2 [a#4,d5,f5]@2 [a#4,d5,f5] [d5,g5]"
const U = "[a4,c5,e5]@2 [a4,c5,e5]@2 [a4,d5] [g4,c5]"
const V = "[a4,c5] [a4,d5]@2 ~ a4 c5"
const W = "[f4,a#4,d5]@2 [f4,a#4,d5]@2 [a#4,d5] [a#4,e5]"
const X = "[a4,c5,f5]@2 [a4,c5,f5]@2 [c5,f5] [c5,g5]"
const Y = "[c5,e5]@2 [c5,e5]@2 [a4,d5] c5"
const Z = "[f4,a4,d5]@2 ~@2 a4 c5"
const AA = "[f4,a4,d5]@2 [f4,a4,d5]@2 [a4,d5] [a4,f5]"
const AB = "[a#4,d5,g5]@2 [a#4,d5,g5]@2 [d5,g5] [d5,a5]"
const AC = "[d5,g5,a#5]@2 [d5,g5,a#5]@2 [f5,a5] [e5,g5]"
const AD = "[f5,a5] d5@2 ~ d5 e5"
const AE = "[a#4,d5,f5]@2 [a#4,d5,f5]@2 [a#4,d5,g5]@2"
const AF = "[f5,a5] d5@2 ~ d5 f5"
const AG = "[a4,c#5,e5]@2 [a4,c#5,e5]@2 d5 c#5"
const AH = "[a4,d5]@2 [a4,d5]@2 [a4,c5,e5]@2"
const AI = "[c5,d5,f5]@2 f5 f5 [a#4,d5,g5]@2"
const AJ = "[d5,a5] f5 ~@2 [a4,f5] [a4,d5]"
const AK = "a4 ~@5"
const AL = "[d5,g5,a#5] ~@3 [a#4,g5] [a#4,d5]"
const AM = "a#4 ~@5"
const AN = "[c#4,e4] [c#4,e4]@2 [g3,d4]@3"
const AO = "[a3,c#4,f4]@3 ~ f4 g4"
const AP = "[d4,f4,a4]@2 [d4,f4,a4]@2 [d4,f4,a4]@2"
const AQ = "[d4,f4,a#4] [d4,f4,a4] ~@4"
const AR = "[c4,e4,g4]@2 [c4,e4,g4]@2 [c4,e4,g4]@2"
const AS = "[c4,e4,g4] [c4,f4,a4] ~@4"
const AT = "[c#4,e4,g4]@2 [c#4,f4]@2 [a3,e4]@2"
const AU = "[f3,a3,d4]@2 ~@2 d4 e4"
const AV = "[a3,d4,f4]@4 g4 a4"
const AW = "[c4,g4]@2 [c4,f4]@2 [c4,e4]@2"
const AX = "[a3,c4,f4]@2 [a3,c4,g4]@2 [a3,c4,a4]@2"
const AY = "[c4,e4,g4]@2 ~@2 f4 g4"
const AZ = "[c4,f4,a4]@2 ~@2 g4 f4"
const BA = "[c#4,e4]@2 [c#4,f4]@2 [c#4,e4]@2"
const BB = "[f3,a3,d4]@2 ~@2 e4 c4"
const BC = "[f3,a3,d4] ~@3 d5 e5"
const BD = "[a4,d5,f5]@2 ~@2 e5 f5"
const BE = "[c5,g5]@2 [c5,f5]@2 [c5,g5]@2"
const BF = "[f5,a5]@2 [c5,g5]@2 [c5,f5]@2"
const BG = "[f4,a#4,d5]@2 ~@2 d5 e5"
const BH = "[a4,d5,f5]@2 [a4,d5,g5]@2 [d5,a5]@2"
const BI = "[a#4,d5,a#5]@2 [a#4,d5]@2 [a#4,g5]@2"
const BJ = "[a4,f5]@2 ~@2 g5 e5"
const BK = "[a4,d5]@2 ~@2 e5 c#5"
const BL = "[d5,f5,a5]@2 ~@4"
const BM = "[d5,g5,a#5]@2 ~@4"
const BN = "[c5,f5,a5]@2 [c5,f5,a5]@2 [c5,f5,a5]@2"
const BO = "[c5,e5,a5] g5 ~@4"
const BP = "[a#4,d5,g5]@2 ~@4"
const BQ = "[a4,d5,f5]@2 ~@4"
const BR = "[a4,f5]@2 [a4,g5]@2 [a4,e5]@2"
const BS = "[f4,a4,d5]@3 d5 e5 f5"
const BT = "[d5,f5,a5]@3 d5 e5 f5"
const BU = "[d5,f5,a#5]@3 d5 e5 f5"
const BV = "[c5,f5,a5]@2 [c5,f5,a5]@2 [f5,c6]@2"
const BW = "[f4,a4,d5]@3 ~@3"
const BX = "d4@6"

const rightHand = note(
  cat(
    A, // bar 1
    B, // bar 2
    A, // bar 3
    B, // bar 4
    A, // bar 5
    C, // bar 6
    D, // bar 7
    E, // bar 8
    F, // bar 9
    G, // bar 10
    H, // bar 11
    I, // bar 12
    F, // bar 13
    J, // bar 14
    K, // bar 15
    L, // bar 16
    M, // bar 17
    N, // bar 18
    O, // bar 19
    P, // bar 20
    Q, // bar 21
    R, // bar 22
    S, // bar 23
    T, // bar 24
    U, // bar 25
    V, // bar 26
    W, // bar 27
    X, // bar 28
    Y, // bar 29
    Z, // bar 30
    AA, // bar 31
    AB, // bar 32
    AC, // bar 33
    AD, // bar 34
    AE, // bar 35
    AF, // bar 36
    AG, // bar 37
    AH, // bar 38
    AI, // bar 39
    AJ, // bar 40
    AK, // bar 41
    AL, // bar 42
    AM, // bar 43
    AN, // bar 44
    AO, // bar 45
    AP, // bar 46
    AQ, // bar 47
    AR, // bar 48
    AS, // bar 49
    AP, // bar 50
    AQ, // bar 51
    AT, // bar 52
    AU, // bar 53
    AV, // bar 54
    AW, // bar 55
    AX, // bar 56
    AY, // bar 57
    AZ, // bar 58
    BA, // bar 59
    BB, // bar 60
    BC, // bar 61
    BD, // bar 62
    BE, // bar 63
    BF, // bar 64
    BG, // bar 65
    BH, // bar 66
    BI, // bar 67
    BJ, // bar 68
    BK, // bar 69
    BL, // bar 70
    BM, // bar 71
    BN, // bar 72
    BO, // bar 73
    BP, // bar 74
    BQ, // bar 75
    BR, // bar 76
    BS, // bar 77
    BT, // bar 78
    BU, // bar 79
    BV, // bar 80
    BO, // bar 81
    BP, // bar 82
    BQ, // bar 83
    BR, // bar 84
    BW, // bar 85
    BX, // bar 86
  ),
)

const BY = "[d1,d2]@6"
const BZ = "[d1,d2]@3 [d1,d2]@3"
const CA = "[d2,d3]@2 [d2,d3] [d2,d3]@2 [c2,c3]"
const CB = "[a#1,a#2]@2 [a#1,a#2] [a#1,a#2]@2 [a#1,a#2]"
const CC = "[a1,a2]@2 [a1,a2] [a1,a2]@2 [a1,a2]"
const CD = "[d2,d3]@2 [d2,d3] [d2,d3]@2 [d2,d3]"
const CE = "[g1,g2]@2 [g1,g2] [g1,g2]@2 [g1,g2]"
const CF = "[f1,f2]@2 [f1,f2] [f1,f2]@2 [f1,f2]"
const CG = "[c2,c3]@2 [c2,c3] [a1,a2]@2 [a1,a2]"
const CH = "[d2,d3]@2 [d2,d3]@2 [c2,c3]@2"
const CI = "[c2,c3]@2 [c2,c3]@2 [a#1,a#2]@2"
const CJ = "[d2,d3]@2 [d2,d3] [d2,d3] [d2,d3] [d2,d3]"
const CK = "[c2,c3]@2 [c2,c3] [c2,c3]@2 [c2,c3]"
const CL = "[f2,f3]@2 [f2,f3] [f2,f3] [f2,f3] [f2,f3]"
const CM = "[c2,c3]@2 [c2,c3] [c2,c3] [c2,c3] [c2,c3]"
const CN = "[a1,a2]@2 [a1,a2] [a1,a2] [a1,a2] [a1,a2]"
const CO = "[a#1,a#2]@2 [a#1,a#2] [a#1,a#2] [a#1,a#2] [a#1,a#2]"
const CP = "[g1,g2]@2 [g1,g2] [g1,g2] [g1,g2] [g1,g2]"
const CQ = "[f2,f3]@2 [f2,f3] [f2,f3]@2 [f2,f3]"
const CR = "[d2,d3]@3 [d2,d3] [d2,d3] [d2,d3]"

const leftHand = note(
  cat(
    "~@6", // bar 1
    "~@6", // bar 2
    "~@6", // bar 3
    "~@6", // bar 4
    BY, // bar 5
    BZ, // bar 6
    CA, // bar 7
    CB, // bar 8
    CC, // bar 9
    CD, // bar 10
    CB, // bar 11
    CB, // bar 12
    CC, // bar 13
    CD, // bar 14
    CD, // bar 15
    CB, // bar 16
    CE, // bar 17
    CD, // bar 18
    CB, // bar 19
    CD, // bar 20
    CC, // bar 21
    CC, // bar 22
    CA, // bar 23
    CB, // bar 24
    CC, // bar 25
    CD, // bar 26
    CB, // bar 27
    CF, // bar 28
    CG, // bar 29
    CD, // bar 30
    CD, // bar 31
    CB, // bar 32
    CE, // bar 33
    CD, // bar 34
    CB, // bar 35
    CD, // bar 36
    CC, // bar 37
    CH, // bar 38
    CI, // bar 39
    CC, // bar 40
    CC, // bar 41
    CE, // bar 42
    CE, // bar 43
    CC, // bar 44
    CC, // bar 45
    CD, // bar 46
    CJ, // bar 47
    CK, // bar 48
    CL, // bar 49
    CD, // bar 50
    CJ, // bar 51
    CC, // bar 52
    CD, // bar 53
    CD, // bar 54
    CM, // bar 55
    CL, // bar 56
    CM, // bar 57
    CL, // bar 58
    CN, // bar 59
    CD, // bar 60
    CJ, // bar 61
    CJ, // bar 62
    CM, // bar 63
    CL, // bar 64
    CO, // bar 65
    CJ, // bar 66
    CP, // bar 67
    CN, // bar 68
    CN, // bar 69
    CJ, // bar 70
    CP, // bar 71
    CQ, // bar 72
    CM, // bar 73
    CP, // bar 74
    CN, // bar 75
    CN, // bar 76
    CJ, // bar 77
    CJ, // bar 78
    CO, // bar 79
    CL, // bar 80
    CM, // bar 81
    CP, // bar 82
    CN, // bar 83
    CN, // bar 84
    CR, // bar 85
    BY, // bar 86
  ),
)

const CS = "d4@6"
const CT = "a#4@3 a4 a4 ~"
const CU = "d4@4 d4 e4"
const CV = "f4@4 f4 g4"
const CW = "e4@4 d4 c4"
const CX = "c4 d4 ~@2 a3 c4"
const CY = "f4@3 ~ f4 g4"
const CZ = "d4@2 ~@2 a3 c4"
const DA = "d4@4 d4 f4"
const DB = "g4@4 g4 a4"
const DC = "a#4@4 a4 g4"
const DD = "a4 d4@2 ~ d4 e4"
const DE = "f4@3 ~ g4@2"
const DF = "a4 d4@2 ~ d4 f4"
const DG = "e4@3 ~ f4 d4"
const DH = "e4@3 ~ a4 c5"
const DI = "d5@3 ~ d5 e5"
const DJ = "f5@3 ~ f5 g5"
const DK = "e5@4 d5 c5"
const DL = "c5 d5@3 a4 c5"
const DM = "d5@4 d5 e5"
const DN = "e5@3 ~ d5 c5"
const DO = "d5@2 ~@2 a4 c5"
const DP = "d5@3 ~ d5 f5"
const DQ = "g5@4 g5 a5"
const DR = "a#5@4 a5 g5"
const DS = "a5 d5@2 ~ d5 e5"
const DT = "f5@4 g5@2"
const DU = "a5 d5@2 ~ d5 f5"
const DV = "d5@3 ~ e5@2"
const DW = "[c5,f5]@2 f5@2 g5@2"
const DX = "a5@3 ~ f5@2"
const DY = "a#5@6"
const DZ = "[c4,e4]@3 d4@3"
const EA = "f4@5 ~"
const EB = "a4@5 ~"
const EC = "a#4 ~@5"
const ED = "g4@6"
const EE = "a4 ~@5"
const EF = "g4@2 f4@2 e4@2"
const EG = "d4@2 ~@2 d4 e4"
const EH = "[a3,f4]@6"
const EI = "g4@3 ~ e4@2"
const EJ = "f4@2 g4@2 a4@2"
const EK = "[c4,g4]@6"
const EL = "a4@3 ~ g4 f4"
const EM = "e4@2 f4@2 e4@2"
const EN = "d4@3 ~ e4 c4"
const EO = "d4@3 ~ d5 e5"
const EP = "[a4,f5]@6"
const EQ = "g5@2 f5@2 g5@2"
const ER = "a5@2 g5@2 f5@2"
const ES = "[f4,d5]@4 e5@2"
const ET = "f5@2 g5@2 a5@2"
const EU = "a#5@2 d5@2 g5@2"
const EV = "f5@3 ~ g5 e5"
const EW = "d5@6"
const EX = "a5@6"
const EY = "a#5@5 ~"
const EZ = "a5@2 a5@2 a5@2"
const FA = "a5 g5@3 ~@2"
const FB = "g5@5 ~"
const FC = "f5@6"
const FD = "f5@2 g5@2 e5@2"
const FE = "a5@2 a5@2 c6@2"
const FF = "g5@6"

const track4 = note(
  cat(
    "~@6", // bar 1
    "~@6", // bar 2
    "~@6", // bar 3
    CS, // bar 4
    CS, // bar 5
    CT, // bar 6
    CU, // bar 7
    CV, // bar 8
    CW, // bar 9
    CX, // bar 10
    CU, // bar 11
    CY, // bar 12
    CW, // bar 13
    CZ, // bar 14
    DA, // bar 15
    DB, // bar 16
    DC, // bar 17
    DD, // bar 18
    DE, // bar 19
    DF, // bar 20
    DG, // bar 21
    DH, // bar 22
    DI, // bar 23
    DJ, // bar 24
    DK, // bar 25
    DL, // bar 26
    DM, // bar 27
    DJ, // bar 28
    DN, // bar 29
    DO, // bar 30
    DP, // bar 31
    DQ, // bar 32
    DR, // bar 33
    DS, // bar 34
    DT, // bar 35
    DU, // bar 36
    DN, // bar 37
    DV, // bar 38
    DW, // bar 39
    DX, // bar 40
    "~@6", // bar 41
    DY, // bar 42
    "~@6", // bar 43
    DZ, // bar 44
    EA, // bar 45
    EB, // bar 46
    EC, // bar 47
    ED, // bar 48
    EE, // bar 49
    EB, // bar 50
    EC, // bar 51
    EF, // bar 52
    EG, // bar 53
    EH, // bar 54
    EI, // bar 55
    EJ, // bar 56
    EK, // bar 57
    EL, // bar 58
    EM, // bar 59
    EN, // bar 60
    EO, // bar 61
    EP, // bar 62
    EQ, // bar 63
    ER, // bar 64
    ES, // bar 65
    ET, // bar 66
    EU, // bar 67
    EV, // bar 68
    EW, // bar 69
    EX, // bar 70
    EY, // bar 71
    EZ, // bar 72
    FA, // bar 73
    FB, // bar 74
    FC, // bar 75
    FD, // bar 76
    EW, // bar 77
    EX, // bar 78
    EY, // bar 79
    FE, // bar 80
    FA, // bar 81
    FF, // bar 82
    FC, // bar 83
    FD, // bar 84
    EW, // bar 85
  ),
)

rightHand: rightHand
  .s("gm_piano")
  .room(0.2)

leftHand: leftHand
  .s("gm_piano")
  .room(0.2)

track4: track4
  .s("gm_string_ensemble_1")
  .room(0.2)`;
